import { normalizeTagCode } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../http/errors.js';
import { defineRoute, noSchema, type PublicRequestContext } from '../../http/routes.js';
import { authorizeWebsite } from './website-data.js';

/**
 * Whose a printed asset tag is, for the page its QR code opens on the
 * company's own website (P42 D5, moved behind the website key).
 *
 * The QR code holds `<company website>/a/<code>`. The company's phone app reads
 * the code from it and opens the asset; anybody else who scans it reaches the
 * company's own page, whose server asks here, with its website key, and says
 * whose tag it is. This answers the company's name and short name and nothing
 * about the asset. A company with no website prints its tags with the bare
 * code; Integr8 serves no tag page.
 */

const publicAssetTagSchema = z.object({
  company: z.object({ name: z.string(), slug: z.string() }),
  /** The code, as it is printed: for typing into the app. */
  code: z.string(),
});

export const getWebsiteAssetTagRoute = defineRoute({
  method: 'get',
  path: '/v1/website/asset-tags/:code',
  operationId: 'getWebsiteAssetTag',
  summary: 'Whose a printed asset tag is, for the company website',
  description:
    'For a company’s website server, never a browser: `Authorization: Bearer <website key>`. The company a tag code belongs to, for the page its QR code opens; nothing about the asset. 404 for a code that is unknown, malformed or another company’s. Needs the assets module and a company website (403); rate-limited per key (429).',
  tags: ['website'],
  security: 'public',
  websiteKeyAuth: true,
  allowedWhenReadOnly: true,
  params: z.object({ code: z.string().min(1).max(64) }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The company.', schema: publicAssetTagSchema },
    401: { description: 'No website key, or not a live one (`website_key_invalid`).' },
    403: {
      description:
        'The assets module is off (`feature_disabled`), or the company has no website (`website_missing`).',
    },
    404: { description: 'This company has no such tag.' },
    429: { description: 'Too many requests with this key; slow down.' },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const live = await authorizeWebsite(context, 'tags');
    const code = normalizeTagCode(params.code);
    const tenantId =
      code === undefined
        ? undefined
        : await getPlatformDataSource().publicAssetTags.companyOf(code);
    if (code === undefined || tenantId !== live.tenantId) {
      throw notFound('This company has no such tag.');
    }
    const tenant = await getPlatformDataSource().tenants.findById(tenantId);
    if (tenant === undefined) {
      throw notFound('This company has no such tag.');
    }
    return {
      status: 200,
      body: { company: { name: tenant.name, slug: tenant.slug }, code },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const assetTagPublicRoutes = [getWebsiteAssetTagRoute];
