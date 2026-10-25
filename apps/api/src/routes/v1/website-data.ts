import { formatInvoiceReference, formatQuoteReference, formatWorkOrderReference } from '@integr8/core';
import { getPlatformDataSource, linkOpens, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, notFound } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { createRateLimiter } from '../../http/rate-limit.js';
import { defineRoute, noSchema, type PublicRequestContext } from '../../http/routes.js';
import { assertTenantServable } from '../../http/suspension.js';
import { companyToday, lineBodies, quoteSummaries } from './sales-quotes.js';
import { invoiceSummaries } from './finance-invoices.js';
import { documentFileLink } from './documents.js';
import { hashWebsiteKey, WEBSITE_KEY_PATTERN } from './documents-public.js';
import { iso } from './schemas.js';

const TAGS = ['website'];
const limiter = createRateLimiter();
const capabilities = {
  files: { setting: 'websiteFilesEnabled', grant: 'website_files', module: 'documents' },
  jobs: { setting: 'websiteJobsEnabled', grant: 'website_jobs', module: undefined },
  quotes: { setting: 'websiteQuotesEnabled', grant: 'website_quotes', module: 'sales' },
  invoices: { setting: 'websiteInvoicesEnabled', grant: 'website_invoices', module: 'finance' },
} as const;
type Capability = keyof typeof capabilities;

async function authorize(
  context: PublicRequestContext,
  capability: Capability,
): Promise<{ id: string; tenantId: string }> {
  const token = context.bearerToken;
  const live =
    token === null || !WEBSITE_KEY_PATTERN.test(token)
      ? undefined
      : await getPlatformDataSource().websiteKeys.findLiveByHash(hashWebsiteKey(token));
  if (live === undefined) {
    throw new ApiError(401, 'website_key_invalid', 'This website key is not valid.');
  }
  await limiter.consume({
    bucketKey: `website-key:${live.id}`,
    limit: context.config.WEBSITE_LOOKUP_RATE_LIMIT,
    windowMs: context.config.WEBSITE_LOOKUP_RATE_WINDOW_SECONDS * 1000,
    logger: context.logger,
  });
  await assertTenantServable(live.tenantId);
  const control = capabilities[capability];
  const platformFlags = await getPlatformDataSource().settings.flagsFor(live.tenantId);
  if (platformFlags[control.grant] !== true) {
    throw new ApiError(403, 'feature_disabled', `Website ${capability} access is disabled by Integr8.`);
  }
  const company = await withTenant(live.tenantId, (tx) => tx.settings.get());
  if (!company[control.setting]) {
    throw new ApiError(403, 'feature_disabled', `Website ${capability} access is disabled by the company.`);
  }
  if (control.module !== undefined && !(await isFeatureEnabled(live.tenantId, control.module))) {
    throw new ApiError(403, 'feature_disabled', `The ${control.module} module is not enabled.`);
  }
  return live;
}

const jobSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  scheduledFrom: z.iso.datetime().nullable(),
  dueBy: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const websiteJobRoute = defineRoute({
  method: 'get',
  path: '/v1/website/jobs/:workOrderId',
  operationId: 'getWebsiteJobStatus',
  summary: 'Get one job status for a company website',
  description: 'Server-side website key required. Returns a customer-safe status summary for one company job; never a job list or internal instructions.',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  params: z.object({ workOrderId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The job status.', schema: jobSchema },
    401: { description: 'Invalid or disabled website key.' },
    403: { description: 'Website job access is disabled by the company or Integr8.' },
    404: { description: 'No such job.' },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const live = await authorize(context, 'jobs');
    const job = await withTenant(live.tenantId, (tx) => tx.workOrders.find(params.workOrderId));
    await getPlatformDataSource().websiteKeys.recordUse(live.id, job !== undefined);
    if (job === undefined) throw notFound('No such job.');
    return {
      status: 200,
      body: {
        id: job.id,
        reference: formatWorkOrderReference(job.reference),
        title: job.title,
        status: job.state,
        scheduledFrom: job.dueFrom === null ? null : iso(job.dueFrom),
        dueBy: job.dueBy === null ? null : iso(job.dueBy),
        updatedAt: iso(job.updatedAt),
      },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

const quoteSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  currencyCode: z.string(),
  validUntil: z.iso.date().nullable(),
  totals: z.object({ gross: z.string(), discount: z.string(), net: z.string(), tax: z.string(), total: z.string() }),
  introduction: z.string().nullable(),
  terms: z.string().nullable(),
  lines: z.array(z.object({ position: z.number().int(), description: z.string(), quantity: z.string(), unit: z.string(), unitPrice: z.string(), total: z.string() })),
  updatedAt: z.iso.datetime(),
});

export const websiteQuoteRoute = defineRoute({
  method: 'get',
  path: '/v1/website/quotes/:quoteId',
  operationId: 'getWebsiteQuote',
  summary: 'Get one quote for a company website',
  description: 'Server-side website key required. Returns the customer-visible issued quote and its lines; drafts and internal notes are never exposed.',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  params: z.object({ quoteId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The customer-visible quote.', schema: quoteSchema },
    401: { description: 'Invalid or disabled website key.' },
    403: { description: 'Website quote access is disabled by the company or Integr8.' },
    404: { description: 'No issued quote.' },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const live = await authorize(context, 'quotes');
    const result = await withTenant(live.tenantId, async (tx) => {
      const quote = await tx.salesQuotes.findQuote(params.quoteId);
      if (quote === undefined || quote.issuedAt === null || quote.status === 'draft') return undefined;
      const [summary] = await quoteSummaries(tx, [quote], await companyToday(tx));
      const lines = await tx.salesQuotes.quoteLines(quote.id);
      return { quote, summary: summary!, lines };
    });
    await getPlatformDataSource().websiteKeys.recordUse(live.id, result !== undefined);
    if (result === undefined) throw notFound('No issued quote.');
    return {
      status: 200,
      body: {
        id: result.quote.id,
        reference: formatQuoteReference(result.quote.reference, result.quote.revision),
        title: result.quote.title,
        status: result.quote.status,
        currencyCode: result.quote.currencyCode,
        validUntil: result.quote.validUntil,
        totals: result.summary.totals,
        introduction: result.quote.introduction,
        terms: result.quote.terms,
        lines: lineBodies(result.lines).map(({ position, description, quantity, unit, unitPrice, total }) => ({ position, description, quantity, unit, unitPrice, total })),
        updatedAt: iso(result.quote.updatedAt),
      },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

const invoiceSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  status: z.string(),
  currencyCode: z.string(),
  issueDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  amounts: z.record(z.string(), z.string()),
  notes: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const websiteInvoiceRoute = defineRoute({
  method: 'get',
  path: '/v1/website/invoices/:invoiceId',
  operationId: 'getWebsiteInvoice',
  summary: 'Get one invoice status for a company website',
  description: 'Server-side website key required. Returns a customer-safe issued invoice summary; drafts and internal notes are never exposed.',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  params: z.object({ invoiceId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The customer-visible invoice.', schema: invoiceSchema },
    401: { description: 'Invalid or disabled website key.' },
    403: { description: 'Website invoice access is disabled by the company or Integr8.' },
    404: { description: 'No issued invoice.' },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const live = await authorize(context, 'invoices');
    const result = await withTenant(live.tenantId, async (tx) => {
      const invoice = await tx.financeInvoices.findInvoice(params.invoiceId);
      if (invoice === undefined || invoice.issuedAt === null || invoice.reference === null) return undefined;
      const [summary] = await invoiceSummaries(tx, [invoice], await companyToday(tx));
      return { invoice, summary: summary! };
    });
    await getPlatformDataSource().websiteKeys.recordUse(live.id, result !== undefined);
    if (result === undefined) throw notFound('No issued invoice.');
    return {
      status: 200,
      body: {
        id: result.invoice.id,
        reference: formatInvoiceReference(result.invoice.reference!),
        status: result.summary.status,
        currencyCode: result.invoice.currencyCode,
        issueDate: result.invoice.issueDate,
        dueDate: result.invoice.dueDate,
        amounts: result.summary.amounts,
        notes: result.invoice.notes,
        updatedAt: iso(result.invoice.updatedAt),
      },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

const fileSchema = z.object({
  documentId: z.uuid(),
  title: z.string(),
  pageCount: z.number().int().nullable(),
  viewUrl: z.string(),
  downloadUrl: z.string(),
  expiresAt: z.iso.datetime(),
});

export const websiteFileRoute = defineRoute({
  method: 'get',
  path: '/v1/website/files/:documentId',
  operationId: 'getWebsiteFile',
  summary: 'Get short-lived links to one customer document',
  description: 'Server-side website key required. The document ID must already be known to the company website. Returns five-minute links; never a file listing.',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  params: z.object({ documentId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Short-lived view and download links.', schema: fileSchema },
    401: { description: 'Invalid or disabled website key.' },
    403: { description: 'Website file access is disabled by the company or Integr8.' },
    404: { description: 'No available customer document.' },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const live = await authorize(context, 'files');
    const document = await withTenant(live.tenantId, (tx) => tx.documents.find(params.documentId));
    const available = document !== undefined && document.status === 'ready' && linkOpens(document);
    await getPlatformDataSource().websiteKeys.recordUse(live.id, available);
    if (!available || document === undefined) throw notFound('No available customer document.');
    const [view, download] = await Promise.all([
      documentFileLink(context, live.tenantId, document, 'inline'),
      documentFileLink(context, live.tenantId, document, 'attachment'),
    ]);
    return {
      status: 200,
      body: {
        documentId: document.id,
        title: document.title,
        pageCount: document.pageCount,
        viewUrl: view.url,
        downloadUrl: download.url,
        expiresAt: view.expiresAt,
      },
      headers: { 'cache-control': 'no-store' },
    };
  },
});

export const websiteDataRoutes = [websiteJobRoute, websiteQuoteRoute, websiteInvoiceRoute, websiteFileRoute];
