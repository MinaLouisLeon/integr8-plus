import { timingSafeEqual } from 'node:crypto';
import { companyThemeSchema, getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, notFound } from '../../http/errors.js';
import { defineRoute, noSchema, type PublicRequestContext } from '../../http/routes.js';
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
  /**
   * Paths on this API that answer with the image, or null when the company has
   * none. Paths rather than links because the signed link to the file lasts
   * minutes and this answer is cached; the path redirects to a fresh link.
   */
  logoPath: z.string().nullable(),
  appIconPath: z.string().nullable(),
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
  handler: async ({ params }) => {
    const brand = await brandFor(params.slug);
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
        logoPath: brand.logoMediaId === null ? null : `/v1/public/companies/${params.slug}/logo`,
        appIconPath:
          brand.appIconMediaId === null ? null : `/v1/public/companies/${params.slug}/app-icon`,
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
    const brand = await brandFor(params.slug);
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
    const brand = await brandFor(params.slug);
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
    'Every active company with “build apps” switched on, for the release pipeline. Needs `Authorization: Bearer <BUILD_TOKEN>`; answers 404 when the deployment has no such token.',
  tags: TAGS,
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The companies, by slug.',
      schema: z.object({
        items: z.array(z.object({ slug: z.string(), name: z.string() })),
      }),
    },
    401: { description: 'The token is missing or wrong.' },
    404: { description: 'This deployment builds no company apps.' },
  },
  handler: async (_input, context) => {
    const expected = context.config.BUILD_TOKEN;
    if (expected === undefined) {
      throw notFound('This deployment builds no company apps.');
    }
    const presented = context.bearerToken ?? '';
    if (!sameSecret(presented, expected)) {
      throw new ApiError(401, 'build_token_rejected', 'The build token was not accepted.');
    }
    const companies = await getPlatformDataSource().tenantSettings.companiesWithApps();
    return {
      status: 200,
      body: { items: companies.map((company) => ({ slug: company.slug, name: company.name })) },
    };
  },
});

async function brandFor(slug: string) {
  const brand = await getPlatformDataSource().tenantSettings.brandBySlug(slug);
  if (brand === undefined) {
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
