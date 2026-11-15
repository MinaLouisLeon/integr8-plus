import { normalizeTagCode } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { defineRoute, noSchema } from '../../http/routes.js';

/**
 * Whose a printed asset tag is, for the public page its QR code opens (P42,
 * the owner's decision D5).
 *
 * The QR code holds `<public site>/a/<code>`. The company's phone app reads
 * the code from it and opens the asset; anybody else who scans it reaches the
 * public page, which says whose tag it is and to scan it with that company's
 * app. So this answers the company's name and short name (its public brand is
 * at `/v1/public/companies/:slug/brand`) and nothing about the asset.
 */

const publicAssetTagSchema = z.object({
  company: z.object({ name: z.string(), slug: z.string() }),
  /** The code, as it is printed: for typing into the app. */
  code: z.string(),
});

export const getPublicAssetTagRoute = defineRoute({
  method: 'get',
  path: '/v1/public/asset-tags/:code',
  operationId: 'getPublicAssetTag',
  summary: 'Whose a printed asset tag is',
  description:
    'Public. The company a tag code belongs to, for the page its QR code opens; nothing about the asset. 404 for a code that is unknown, malformed, or belongs to a company without the assets module.',
  tags: ['assets'],
  security: 'public',
  params: z.object({ code: z.string().min(1).max(64) }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The company.', schema: publicAssetTagSchema },
    404: { description: 'No company has this tag.' },
  },
  handler: async ({ params }) => {
    const code = normalizeTagCode(params.code);
    const tenantId =
      code === undefined
        ? undefined
        : await getPlatformDataSource().publicAssetTags.companyOf(code);
    if (
      code === undefined ||
      tenantId === undefined ||
      !(await isFeatureEnabled(tenantId, 'assets'))
    ) {
      throw notFound('No company has this tag.');
    }
    const tenant = await getPlatformDataSource().tenants.findById(tenantId);
    if (tenant === undefined) {
      throw notFound('No company has this tag.');
    }
    return {
      status: 200,
      body: { company: { name: tenant.name, slug: tenant.slug }, code },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const assetTagPublicRoutes = [getPublicAssetTagRoute];
