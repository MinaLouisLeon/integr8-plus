import { timingSafeEqual } from 'node:crypto';
import {
  companyThemeSchema,
  getPlatformDataSource,
  PHONE_DISTRIBUTIONS,
  PLAY_TRACKS,
  withTenant,
} from '@integr8/db';
import { storeLinks } from '@integr8/core';
import { z } from 'zod';
import { ApiError, notFound } from '../../http/errors.js';
import { defineRoute, noSchema, type PublicRequestContext } from '../../http/routes.js';
import { createRateLimiter } from '../../http/rate-limit.js';
import { getStorage } from '../../media/tenant-storage.js';

/**
 * A company's brand, for anybody who knows its short name.
 *
 * Each company's apps are built for that company: the installer and the phone
 * app carry its name and icon, and the sign-in screen already wears its logo
 * and colours before anybody has signed in. Two readers need the brand with no
 * session to ask with: the build pipeline, stamping a company's name and icon
 * into an installer, and a freshly installed app painting its first screen.
 * Hence public.
 *
 * It exposes the brand and nothing else: no plan, no people, no activity, and
 * the slug has to be known. A company that does not exist and one that was
 * deleted both answer 404.
 */

const TAGS = ['brand'];

const slugParams = z.object({
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u),
});

export const publicBrandSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** `#rrggbb`, or null for the product's own accent. */
  brandColour: z.string().nullable(),
  /** `#rrggbb` for the dashboard shell, or null for the product's own. */
  shellColour: z.string().nullable(),
  defaultTheme: companyThemeSchema,
  /** The company's own website, https only, or null. */
  websiteUrl: z.string().nullable(),
  /** Whether to print the name beside the logo (0075); shown anyway without a logo. */
  showCompanyName: z.boolean(),
  /**
   * Paths on this API that answer with the image, or null when the company has
   * none. Paths rather than links because the signed link to the file lasts
   * minutes and this answer is cached; the path redirects to a fresh link.
   */
  logoPath: z.string().nullable(),
  appIconPath: z.string().nullable(),
  /**
   * The company's own Google Play and App Store pages when its phone app is
   * published there (0023), so a store build's Update opens the store; null
   * for an app Integr8 staff send as an APK. Store pages are public anyway.
   */
  storeLinks: z.object({ googlePlay: z.string(), appStore: z.string().nullable() }).nullable(),
});

/** Cached briefly: a brand changes rarely, and a phone opens this on every launch. */
const CACHE = { 'cache-control': 'public, max-age=300' };

export const publicBrandRoute = defineRoute({
  method: 'get',
  path: '/v1/public/companies/:slug/brand',
  operationId: 'getPublicBrand',
  summary: 'A company’s brand, by its short name',
  description:
    'Name, colours, default theme, website and where to fetch the logo and app icon. Public: a company’s app is built with this before anybody signs in. Nothing else about the company is exposed.',
  tags: TAGS,
  security: 'public',
  params: slugParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The brand.', schema: publicBrandSchema },
    404: { description: 'No company has this short name.' },
  },
  handler: async ({ params }, context) => {
    const brand = await brandFor(params.slug, context);
    return {
      status: 200,
      headers: CACHE,
      body: {
        slug: params.slug,
        name: brand.name,
        brandColour: brand.brandColour,
        shellColour: brand.shellColour,
        defaultTheme: brand.defaultTheme,
        websiteUrl: brand.websiteUrl,
        showCompanyName: brand.showCompanyName,
        logoPath: brand.logoMediaId === null ? null : `/v1/public/companies/${params.slug}/logo`,
        appIconPath:
          brand.appIconMediaId === null ? null : `/v1/public/companies/${params.slug}/app-icon`,
        storeLinks:
          brand.phoneDistribution === 'stores' ? storeLinks(params.slug, brand.appStoreId) : null,
      },
    };
  },
});

export const publicLogoRoute = defineRoute({
  method: 'get',
  path: '/v1/public/companies/:slug/logo',
  operationId: 'getPublicLogo',
  summary: 'A company’s logo',
  description: 'Redirects to a short-lived link to the image. 404 when the company has no logo.',
  tags: TAGS,
  security: 'public',
  params: slugParams,
  query: noSchema,
  body: noSchema,
  responses: {
    302: { description: 'A link to the image, valid for a few minutes.' },
    404: { description: 'No such company, or it has no logo.' },
  },
  handler: async ({ params }, context) => {
    const brand = await brandFor(params.slug, context);
    return redirectToImage(context, brand.tenantId, brand.logoMediaId, 'logo');
  },
});

export const publicAppIconRoute = defineRoute({
  method: 'get',
  path: '/v1/public/companies/:slug/app-icon',
  operationId: 'getPublicAppIcon',
  summary: 'A company’s app icon',
  description:
    'Redirects to a short-lived link to the square image its installers and phone apps use. 404 when the company has none; the build then uses the product’s own icon.',
  tags: TAGS,
  security: 'public',
  params: slugParams,
  query: noSchema,
  body: noSchema,
  responses: {
    302: { description: 'A link to the image, valid for a few minutes.' },
    404: { description: 'No such company, or it has no app icon.' },
  },
  handler: async ({ params }, context) => {
    const brand = await brandFor(params.slug, context);
    return redirectToImage(context, brand.tenantId, brand.appIconMediaId, 'app icon');
  },
});

/**
 * Which companies' apps the release pipeline builds.
 *
 * Read by the workflow that fans a release out to every company with its own
 * apps. Not public: a list of customers is a list of customers. Guarded by a
 * bearer token the deployment and GitHub share (`BUILD_TOKEN`) rather than a
 * platform session, because a workflow has nobody to sign in as.
 */
export const buildCompaniesRoute = defineRoute({
  method: 'get',
  path: '/v1/build/companies',
  operationId: 'listBuildCompanies',
  summary: 'The companies whose own apps are built',
  description:
    'Every active company with “build apps” switched on, for the release pipeline, with how its phone app is published (0023): `apk` (an APK Integr8 staff send) or `stores` (the company’s own Google Play and App Store accounts, on `playTrack`, with the App Store app number `appStoreId`). Needs `Authorization: Bearer <BUILD_TOKEN>`; answers 404 when the deployment has no such token.',
  tags: TAGS,
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The companies, by slug.',
      schema: z.object({
        items: z.array(
          z.object({
            slug: z.string(),
            name: z.string(),
            phone: z.object({
              distribution: z.enum(PHONE_DISTRIBUTIONS),
              playTrack: z.enum(PLAY_TRACKS),
              appStoreId: z.string().nullable(),
            }),
          }),
        ),
      }),
    },
    403: { description: 'The build token is missing or wrong (`build_token_rejected`).' },
    404: { description: 'This deployment builds no company apps.' },
  },
  handler: async (_input, context) => {
    const expected = context.config.BUILD_TOKEN;
    if (expected === undefined) {
      throw notFound('This deployment builds no company apps.');
    }
    const presented = context.bearerToken ?? '';
    if (!sameSecret(presented, expected)) {
      throw new ApiError(403, 'build_token_rejected', 'The build token was not accepted.');
    }
    const companies = await getPlatformDataSource().tenantSettings.companiesWithApps();
    return {
      status: 200,
      body: {
        items: companies.map((company) => ({
          slug: company.slug,
          name: company.name,
          phone: {
            distribution: company.phoneDistribution,
            playTrack: company.playTrack,
            appStoreId: company.appStoreId,
          },
        })),
      },
    };
  },
});

/**
 * Lookups by a name nobody has, per address: few enough that walking a list
 * of likely company names takes days, not minutes, since these routes answer
 * anybody and a 404 says the name is free. Only misses count, so an office
 * whose phones all open the app at nine shares nothing: its apps only ever
 * ask for their own company. Constants rather than settings, because no
 * deployment has a reason to loosen them.
 */
const MISS_LIMIT = 20;
const MISS_WINDOW_MS = 60 * 60 * 1000;
const missLimiter = createRateLimiter();

async function brandFor(slug: string, context: PublicRequestContext) {
  const bucketKey = context.ipAddress === null ? null : `public-brand-miss:${context.ipAddress}`;
  if (bucketKey !== null) {
    missLimiter.assertOpen(bucketKey);
  }
  const brand = await getPlatformDataSource().tenantSettings.brandBySlug(slug);
  if (brand === undefined) {
    if (bucketKey !== null) {
      await missLimiter.consume({
        bucketKey,
        limit: MISS_LIMIT,
        windowMs: MISS_WINDOW_MS,
        logger: context.logger,
      });
    }
    throw notFound('No company has this short name.');
  }
  return brand;
}

async function redirectToImage(
  context: PublicRequestContext,
  tenantId: string,
  mediaId: string | null,
  what: string,
) {
  if (mediaId === null) {
    throw notFound(`This company has no ${what}.`);
  }
  const file = await withTenant(tenantId, (tx) => tx.files.find(mediaId));
  if (file?.deletedAt !== null) {
    throw notFound(`This company has no ${what}.`);
  }
  const store = await getStorage(context.services.media, tenantId);
  const link = await store.createDownload({
    key: file.storageKey,
    contentType: file.contentType,
    expiresInSeconds: 5 * 60,
  });
  return {
    status: 302,
    headers: { location: link.url, 'cache-control': 'public, max-age=60' },
    body: {},
  };
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const publicBrandRoutes = [
  publicBrandRoute,
  publicLogoRoute,
  publicAppIconRoute,
  buildCompaniesRoute,
];
