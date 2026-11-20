import { createHash } from 'node:crypto';
import { type DocumentRecord, getPlatformDataSource, linkOpens, withTenant } from '@integr8/db';
import { z } from 'zod';
import {
  type CompanySite,
  documentLink,
  hasCompanySite,
  websiteMissing,
} from '../../documents/render.js';
import { ApiError } from '../../http/errors.js';
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
 * A document from outside the company: only through the company's own website.
 *
 * Integr8 serves no document to anybody without a key. A shared document's QR
 * code and link open a page on the company's website (`/documents/<code>`, or
 * the company's link pattern, 0075), whose server asks for it here with the
 * website key Integr8 issued: one document by its code, or the documents a
 * visitor's search matches (D10, 0075). A company with no website set has no
 * key that answers (403 `website_missing`) and cannot share in the first place.
 * An expired, unshared or unfinished document is never found.
 */

const TAGS = ['documents'];

const codeParams = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/u) });

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
  if (!hasCompanySite(websiteAccess)) {
    throw websiteMissing();
  }
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
  site: CompanySite,
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
    link: documentLink(found.document.publicCode, site),
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
    const { matches, site } = await withTenant(live.tenantId, async (tx) => {
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
      return { matches: found, site: await tx.settings.get() };
    });
    await getPlatformDataSource().websiteKeys.recordUse(live.id, matches.length > 0);
    const documents = await Promise.all(
      matches.map((match) => websiteDocument(context, live.tenantId, match, site)),
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
      if (document?.status !== 'ready' || !document.shareable || !linkOpens(document)) {
        return undefined;
      }
      const form = document.formId == null ? undefined : await tx.forms.findForm(document.formId);
      return {
        found: { document, formTitle: form?.title ?? '' },
        site: await tx.settings.get(),
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
              document: await websiteDocument(context, live.tenantId, match.found, match.site),
            },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const documentPublicRoutes = [websiteDocumentLookupRoute, websiteDocumentByCodeRoute];
