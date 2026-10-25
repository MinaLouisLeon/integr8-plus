import { createHash } from 'node:crypto';
import { type DocumentRecord, getPlatformDataSource, linkOpens, withTenant } from '@integr8/db';
import { z } from 'zod';
import { documentLink } from '../../documents/render.js';
import { ApiError, notFound } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { createRateLimiter } from '../../http/rate-limit.js';
import {
  defineRoute,
  type HandlerResult,
  noSchema,
  type PublicRequestContext,
} from '../../http/routes.js';
import { assertTenantServable } from '../../http/suspension.js';
import { documentFileLink } from './documents.js';
import { iso } from './schemas.js';

/**
 * The two doors to a document from outside the company (docs/documents
 * ADR-0001).
 *
 * **The QR code's link** (D7): `/d/<code>` on the web app reads these. The code
 * is a 128-bit capability: whoever holds it sees the company, the form, the
 * date, and may view and download the PDF, with no account. A code that is
 * unknown, deleted, not yet printed, or whose company is not active answers
 * 404 alike; one the company expired answers 410, which tells the holder
 * nothing they did not already have.
 *
 * **The website lookup** (D10): a company's own server, holding a website key
 * issued from the dashboard, asks for one document by the template's lookup
 * field. One match or none, never a list; an expired document is not found.
 */

const TAGS = ['documents'];

const codeParams = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/u) });

const publicDocumentSchema = z.object({
  company: z.object({
    name: z.string(),
    /** A path on this API that answers with the logo, or null. */
    logoPath: z.string().nullable(),
    brandColour: z.string().nullable(),
  }),
  document: z.object({
    title: z.string(),
    formTitle: z.string(),
    createdAt: z.iso.datetime(),
    pageCount: z.number().int().nullable(),
    byteSize: z.number().int().nullable(),
  }),
});

interface Found {
  tenantId: string;
  document: DocumentRecord;
  brand: { name: string; slug: string; logoMediaId: string | null; brandColour: string | null };
  formTitle: string;
}

async function byCode(code: string): Promise<Found> {
  const found = await getPlatformDataSource().publicDocuments.byCode(code);
  if (found === undefined || !(await isFeatureEnabled(found.tenantId, 'documents'))) {
    throw notFound('This link is not valid.');
  }
  const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(found.tenantId);
  if (brand === undefined) {
    throw notFound('This link is not valid.');
  }
  const { document, formTitle } = await withTenant(found.tenantId, async (tx) => {
    const record = await tx.documents.find(found.documentId);
    const form = record === undefined ? undefined : await tx.forms.findForm(record.formId);
    return { document: record, formTitle: form?.title ?? '' };
  });
  if (document?.status !== 'ready') {
    throw notFound('This link is not valid.');
  }
  if (!linkOpens(document)) {
    throw new ApiError(410, 'document_expired', 'This document is no longer available.');
  }
  return { tenantId: found.tenantId, document, brand, formTitle };
}

function publicBody(found: Found): z.infer<typeof publicDocumentSchema> {
  return {
    company: {
      name: found.brand.name,
      logoPath:
        found.brand.logoMediaId === null ? null : `/v1/public/companies/${found.brand.slug}/logo`,
      brandColour: found.brand.brandColour,
    },
    document: {
      title: found.document.title,
      formTitle: found.formTitle,
      createdAt: iso(found.document.createdAt),
      pageCount: found.document.pageCount,
      byteSize: found.document.byteSize,
    },
  };
}

export const getPublicDocumentRoute = defineRoute({
  method: 'get',
  path: '/v1/public/documents/:code',
  operationId: 'getPublicDocument',
  summary: 'A document, for whoever holds its QR code',
  description:
    'Public. The company, the form, the title and the date. 404 for a code that is unknown, deleted or not ready; 410 `document_expired` for one the company stopped.',
  tags: TAGS,
  security: 'public',
  params: codeParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document.', schema: publicDocumentSchema },
    404: { description: 'This link is not valid.' },
    410: { description: 'The company stopped this link (`document_expired`).' },
  },
  handler: async ({ params }) => {
    const found = await byCode(params.code);
    return { status: 200, body: publicBody(found), headers: { 'cache-control': 'no-store' } };
  },
});

export const getPublicDocumentFileRoute = defineRoute({
  method: 'get',
  path: '/v1/public/documents/:code/file',
  operationId: 'getPublicDocumentFile',
  summary: 'The PDF, for whoever holds its QR code',
  description:
    'Public. Redirects (302) to a five-minute link to the PDF: `download=true` saves it under its title, otherwise it opens in the browser. A link to put behind a button, not to keep.',
  tags: TAGS,
  security: 'public',
  params: codeParams,
  query: z.object({
    download: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  }),
  body: noSchema,
  responses: {
    302: { description: 'To the PDF.' },
    404: { description: 'This link is not valid.' },
    410: { description: 'The company stopped this link (`document_expired`).' },
  },
  handler: async ({ params, query }, context) => {
    const found = await byCode(params.code);
    const link = await documentFileLink(
      context,
      found.tenantId,
      found.document,
      query.download ? 'attachment' : 'inline',
    );
    return {
      status: 302,
      body: undefined,
      headers: {
        location: link.url,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    };
  },
});

// ---------------------------------------------------------------------------
// The website lookup
// ---------------------------------------------------------------------------

/** What a website key looks like: a prefix to recognise it by, and 256 random bits. */
export const WEBSITE_KEY_PATTERN = /^i8wk_[A-Za-z0-9_-]{43}$/u;

export const hashWebsiteKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

const lookupLimiter = createRateLimiter();

const lookupFieldSchema = z.object({
  /** The document field's key, as agreed with Integr8. */
  field: z.string().min(1).max(64),
  value: z.string().trim().min(1).max(500),
});

const lookupResultSchema = z.object({
  found: z.boolean(),
  document: z
    .object({
      title: z.string(),
      formTitle: z.string(),
      createdAt: z.iso.datetime(),
      pageCount: z.number().int().nullable(),
      /** The QR code's page: stable, safe to show and link to. */
      link: z.string().nullable(),
      /** Five-minute links to the PDF itself, to open or to save. */
      viewUrl: z.string(),
      downloadUrl: z.string(),
      expiresAt: z.iso.datetime(),
      /** The document's fields, in each language the template wrote their labels in. */
      fields: z.array(
        z.object({ key: z.string(), label: z.record(z.string(), z.string()), value: z.string() }),
      ),
    })
    .nullable(),
});

export const websiteDocumentLookupRoute = defineRoute({
  method: 'post',
  path: '/v1/website/documents/lookup',
  operationId: 'lookupWebsiteDocument',
  summary: 'Find one document from the company’s own website',
  description:
    'For a company’s website server, never a browser: `Authorization: Bearer <website key>`. `key` is the template’s lookup field and the value a visitor typed; `confirm` is the second field, required when the template asks for one. Exact after trimming and ignoring case. Answers `found: false` rather than 404, and never more than one document. Rate-limited per key (429).',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  allowedWhenReadOnly: true,
  params: noSchema,
  query: noSchema,
  body: z.object({ key: lookupFieldSchema, confirm: lookupFieldSchema.optional() }),
  responses: {
    200: { description: 'One document, or none.', schema: lookupResultSchema },
    401: { description: 'No website key, or not a live one (`website_key_invalid`).' },
    403: { description: 'The company does not have documents switched on (`feature_disabled`).' },
    429: { description: 'Too many lookups with this key; slow down.' },
  },
  handler: async (
    { body },
    context: PublicRequestContext,
  ): Promise<HandlerResult<z.infer<typeof lookupResultSchema>>> => {
    const key = context.bearerToken;
    const live =
      key === null || !WEBSITE_KEY_PATTERN.test(key)
        ? undefined
        : await getPlatformDataSource().websiteKeys.findLiveByHash(hashWebsiteKey(key));
    if (live === undefined) {
      throw new ApiError(401, 'website_key_invalid', 'This website key is not valid.');
    }
    await lookupLimiter.consume({
      bucketKey: `website-key:${live.id}`,
      limit: context.config.WEBSITE_LOOKUP_RATE_LIMIT,
      windowMs: context.config.WEBSITE_LOOKUP_RATE_WINDOW_SECONDS * 1000,
      logger: context.logger,
    });
    await assertTenantServable(live.tenantId);
    if (!(await isFeatureEnabled(live.tenantId, 'documents'))) {
      throw new ApiError(
        403,
        'feature_disabled',
        'Documents are not switched on for this company.',
      );
    }
    if ((await getPlatformDataSource().settings.flagsFor(live.tenantId)).website_files !== true) {
      throw new ApiError(
        403,
        'feature_disabled',
        'Website file access is not switched on by Integr8.',
      );
    }
    const websiteAccess = await withTenant(live.tenantId, (tx) => tx.settings.get());
    if (!websiteAccess.websiteFilesEnabled) {
      throw new ApiError(
        403,
        'feature_disabled',
        'Website file access is not switched on by this company.',
      );
    }

    const match = await withTenant(live.tenantId, async (tx) => {
      const document = await tx.documents.lookup({ key: body.key, confirm: body.confirm });
      const form = document === undefined ? undefined : await tx.forms.findForm(document.formId);
      return document === undefined ? undefined : { document, formTitle: form?.title ?? '' };
    });
    await getPlatformDataSource().websiteKeys.recordUse(live.id, match !== undefined);
    if (match === undefined) {
      return { status: 200, body: { found: false, document: null } };
    }
    const [view, download] = await Promise.all([
      documentFileLink(context, live.tenantId, match.document, 'inline'),
      documentFileLink(context, live.tenantId, match.document, 'attachment'),
    ]);
    return {
      status: 200,
      body: {
        found: true,
        document: {
          title: match.document.title,
          formTitle: match.formTitle,
          createdAt: iso(match.document.createdAt),
          pageCount: match.document.pageCount,
          link: documentLink(context.config, match.document.publicCode),
          viewUrl: view.url,
          downloadUrl: download.url,
          expiresAt: view.expiresAt,
          fields: match.document.fields.map((field) => ({
            key: field.key,
            label: { ...field.label },
            value: field.value,
          })),
        },
      },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const documentPublicRoutes = [
  getPublicDocumentRoute,
  getPublicDocumentFileRoute,
  websiteDocumentLookupRoute,
];
