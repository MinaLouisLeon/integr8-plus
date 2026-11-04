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
 * unknown, deleted, not yet printed, not shareable (0067), or whose company is
 * not active answers 404 alike; one the company expired answers 410, which
 * tells the holder nothing they did not already have.
 *
 * **The website lookup** (D10): a company's own server, holding a website key
 * issued from the dashboard, asks for one document by its reference (the
 * template's lookup field, or an uploaded document's reference number) and,
 * where the document has one, a second value; or, since 0075, with the one
 * search box's text, matched against every searchable field and answered with
 * up to ten documents. An expired or unshared document is never found. Its
 * page on the company's site (`/documents/<code>`, 0075) asks for one document
 * by its code.
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
    /** The form it was made from; empty for an uploaded document. */
    formTitle: z.string(),
    /** An uploaded document's reference number; null for a generated one (0067). */
    reference: z.string().nullable(),
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
    const form = record?.formId == null ? undefined : await tx.forms.findForm(record.formId);
    return { document: record, formTitle: form?.title ?? '' };
  });
  // Not shared is answered exactly as not found: the holder learns nothing.
  if (document?.status !== 'ready' || !document.shareable) {
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
      reference: found.document.reference,
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
    'Public. The company, the form, the title and the date. 404 for a code that is unknown, deleted, not ready or not shareable; 410 `document_expired` for one the company stopped.',
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

const lookupBodySchema = z
  .object({
    /**
     * The one search box (0075): what a visitor typed, matched exactly against
     * every searchable field of a document, its reference and the fields
     * typed on an uploaded one; never against the customer's name. Send this,
     * or one of the older forms below.
     */
    q: z.string().trim().min(1).max(500).optional(),
    /** Older form: the template's lookup field and the value a visitor typed. */
    key: lookupFieldSchema.optional(),
    /** The second field, when the template asks for one. */
    confirm: lookupFieldSchema.optional(),
    /**
     * Older form, instead of `key`: the reference a visitor typed (a certificate
     * number), matched against whichever field is a document's lookup key, an
     * uploaded document's reference number included (0067).
     */
    reference: z.string().trim().min(1).max(500).optional(),
    /** With `reference`: the second value, such as the customer's name, when the document has one. */
    customer: z.string().trim().min(1).max(500).optional(),
  })
  .refine(
    (body) =>
      [body.q, body.key, body.reference].filter((value) => value !== undefined).length === 1,
    { message: 'Give one of `q`, `reference` or `key`.', path: ['q'] },
  )
  .refine((body) => body.customer === undefined || body.reference !== undefined, {
    message: '`customer` goes with `reference`; with `key`, use `confirm`.',
    path: ['customer'],
  })
  .refine((body) => body.confirm === undefined || body.key !== undefined, {
    message: '`confirm` goes with `key`.',
    path: ['confirm'],
  });

/** At most this many documents answer one search (0075). */
export const WEBSITE_SEARCH_LIMIT = 10;

const websiteDocumentSchema = z.object({
  title: z.string(),
  formTitle: z.string(),
  createdAt: z.iso.datetime(),
  pageCount: z.number().int().nullable(),
  /** The document's own link (its QR code's): stable, safe to show and link to. */
  link: z.string().nullable(),
  /** Its link's code, for the website's own document page (`/documents/<code>`, 0075). */
  code: z.string(),
  /** Five-minute links to the PDF itself, to open or to save. */
  viewUrl: z.string(),
  downloadUrl: z.string(),
  expiresAt: z.iso.datetime(),
  /** The document's fields, in each language the template wrote their labels in. */
  fields: z.array(
    z.object({ key: z.string(), label: z.record(z.string(), z.string()), value: z.string() }),
  ),
});

const lookupResultSchema = z.object({
  found: z.boolean(),
  /** The newest match, or null; kept for websites built before 0075. */
  document: websiteDocumentSchema.nullable(),
  /** Every match, newest first, at most ten; one or none for the older forms. */
  documents: z.array(websiteDocumentSchema),
});

const codeResultSchema = z.object({
  found: z.boolean(),
  document: websiteDocumentSchema.nullable(),
});

/**
 * The company behind a website key, with every switch checked: the key is
 * live, the rate allows it, the company is served, and documents and the
 * website's document access are on on both sides.
 */
async function websiteTenant(
  context: PublicRequestContext,
): Promise<{ id: string; tenantId: string }> {
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
    throw new ApiError(403, 'feature_disabled', 'Documents are not switched on for this company.');
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
  return { id: live.id, tenantId: live.tenantId };
}

interface WebsiteMatch {
  document: DocumentRecord;
  formTitle: string;
}

/** One found document as the website gets it, with fresh links to its PDF. */
async function websiteDocument(
  context: PublicRequestContext,
  tenantId: string,
  found: WebsiteMatch,
  linkPattern: string | null,
): Promise<z.infer<typeof websiteDocumentSchema>> {
  const [view, download] = await Promise.all([
    documentFileLink(context, tenantId, found.document, 'inline'),
    documentFileLink(context, tenantId, found.document, 'attachment'),
  ]);
  return {
    title: found.document.title,
    formTitle: found.formTitle,
    createdAt: iso(found.document.createdAt),
    pageCount: found.document.pageCount,
    link: documentLink(context.config, found.document.publicCode, linkPattern),
    code: found.document.publicCode,
    viewUrl: view.url,
    downloadUrl: download.url,
    expiresAt: view.expiresAt,
    fields: found.document.fields.map((field) => ({
      key: field.key,
      label: { ...field.label },
      value: field.value,
    })),
  };
}

export const websiteDocumentLookupRoute = defineRoute({
  method: 'post',
  path: '/v1/website/documents/lookup',
  operationId: 'lookupWebsiteDocument',
  summary: 'Find documents from the company’s own website',
  description:
    'For a company’s website server, never a browser: `Authorization: Bearer <website key>`. Send `q`, what a visitor typed in the one search box (0075): it is matched exactly, after trimming and ignoring case, against every searchable field of a document (its reference, or a made document’s lookup field, and the fields typed on an uploaded one), never against the customer’s name, and every match is returned in `documents`, newest first, at most ten. The older forms still work and find one document or none: `reference` with `customer` as the second value, or `key` (a named template field) with `confirm`; the second value is required when the document has one. Only documents the company has made shareable, and whose link has not expired, are found. Answers `found: false` rather than 404. Needs the company’s documents switch on both sides (Integr8’s `website_files` and the company’s own). Rate-limited per key (429).',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  allowedWhenReadOnly: true,
  params: noSchema,
  query: noSchema,
  body: lookupBodySchema,
  responses: {
    200: { description: 'The documents found, or none.', schema: lookupResultSchema },
    401: { description: 'No website key, or not a live one (`website_key_invalid`).' },
    403: { description: 'The company does not have documents switched on (`feature_disabled`).' },
    429: { description: 'Too many lookups with this key; slow down.' },
  },
  handler: async (
    { body },
    context: PublicRequestContext,
  ): Promise<HandlerResult<z.infer<typeof lookupResultSchema>>> => {
    const live = await websiteTenant(context);
    const { matches, linkPattern } = await withTenant(live.tenantId, async (tx) => {
      let documents: DocumentRecord[];
      if (body.q !== undefined) {
        documents = await tx.documents.search(body.q, WEBSITE_SEARCH_LIMIT);
      } else {
        const one = await tx.documents.lookup(
          body.reference === undefined
            ? { key: body.key!, confirm: body.confirm }
            : {
                key: { value: body.reference },
                confirm: body.customer === undefined ? undefined : { value: body.customer },
              },
        );
        documents = one === undefined ? [] : [one];
      }
      const found: WebsiteMatch[] = [];
      for (const document of documents) {
        const form = document.formId == null ? undefined : await tx.forms.findForm(document.formId);
        found.push({ document, formTitle: form?.title ?? '' });
      }
      return { matches: found, linkPattern: (await tx.settings.get()).documentLinkPattern };
    });
    await getPlatformDataSource().websiteKeys.recordUse(live.id, matches.length > 0);
    const documents = await Promise.all(
      matches.map((match) => websiteDocument(context, live.tenantId, match, linkPattern)),
    );
    return {
      status: 200,
      body: { found: documents.length > 0, document: documents[0] ?? null, documents },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const websiteDocumentByCodeRoute = defineRoute({
  method: 'get',
  path: '/v1/website/documents/by-code/:code',
  operationId: 'getWebsiteDocumentByCode',
  summary: 'One document by its link’s code, for the company’s own website',
  description:
    'For a company’s website server, never a browser: `Authorization: Bearer <website key>`. The page a document’s QR code and shared link open when the company’s links point at its own website (0075), such as `https://example.com/documents/<code>`, asks this with the code from its address. Found only when the code is one of this company’s documents, shared, and its link has not expired or been stopped; every other case answers `found: false` alike, so the page learns nothing it should not. Same switches and rate limit as the lookup.',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  allowedWhenReadOnly: true,
  params: codeParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document, or none.', schema: codeResultSchema },
    401: { description: 'No website key, or not a live one (`website_key_invalid`).' },
    403: { description: 'The company does not have documents switched on (`feature_disabled`).' },
    429: { description: 'Too many lookups with this key; slow down.' },
  },
  handler: async (
    { params },
    context: PublicRequestContext,
  ): Promise<HandlerResult<z.infer<typeof codeResultSchema>>> => {
    const live = await websiteTenant(context);
    const match = await withTenant(live.tenantId, async (tx) => {
      const document = await tx.documents.findByCode(params.code);
      if (document === undefined || !document.shareable || !linkOpens(document)) {
        return undefined;
      }
      const form = document.formId == null ? undefined : await tx.forms.findForm(document.formId);
      return {
        found: { document, formTitle: form?.title ?? '' },
        linkPattern: (await tx.settings.get()).documentLinkPattern,
      };
    });
    await getPlatformDataSource().websiteKeys.recordUse(live.id, match !== undefined);
    return {
      status: 200,
      body:
        match === undefined
          ? { found: false, document: null }
          : {
              found: true,
              document: await websiteDocument(
                context,
                live.tenantId,
                match.found,
                match.linkPattern,
              ),
            },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const documentPublicRoutes = [
  getPublicDocumentRoute,
  getPublicDocumentFileRoute,
  websiteDocumentLookupRoute,
  websiteDocumentByCodeRoute,
];
