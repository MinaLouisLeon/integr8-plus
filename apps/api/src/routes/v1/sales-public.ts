import { formatQuoteReference, quoteExpired } from '@integr8/core';
import { getPlatformDataSource, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound } from '../../http/errors.js';
import { defineRoute, noSchema, type PublicRequestContext } from '../../http/routes.js';
import { addressSchema } from './operations.js';
import {
  companyToday,
  documentLineSchema,
  hashToken,
  lineBodies,
  totalsSchema,
  winOpportunity,
} from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';
import { authorizeWebsite } from './website-data.js';

/**
 * The customer's view of a quote (CRM/ERP plan, phase S1; ADR-0006), through
 * the company's own website.
 *
 * The customer link opens `<company website>/q/<token>`. The company's server
 * reads the quote here with its website key, and sends the customer's answer
 * the same way. The token is a 256-bit capability: whoever holds it, through
 * that website, reads the issued quote and may accept or reject it until it
 * expires. It exposes the quote and the company's name and logo, and nothing
 * else: no internal notes, no ids, no people. A token that is spent, revised,
 * cancelled, never existed or belongs to another company answers 404 alike.
 * Integr8 serves no quote page itself, and a company with no website has no
 * customer link at all. Needs Integr8's `website_quotes` switch, the company's
 * own and its sales module (`authorizeWebsite`), and is rate-limited per key.
 */

const TAGS = ['website'];

const tokenParams = z.object({
  token: z
    .string()
    .min(32)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
});

export const publicQuoteSchema = z.object({
  company: z.object({
    name: z.string(),
    /** A path on this API that answers with the logo, or null. */
    logoPath: z.string().nullable(),
    brandColour: z.string().nullable(),
  }),
  quote: z.object({
    reference: z.string(),
    title: z.string(),
    status: z.enum(['issued', 'accepted', 'rejected']),
    /** Past `validUntil`: it can no longer be answered. */
    expired: z.boolean(),
    currencyCode: z.string(),
    validUntil: z.iso.date().nullable(),
    issuedAt: z.iso.datetime(),
    customerName: z.string(),
    customerAddress: addressSchema,
    contactName: z.string().nullable(),
    introduction: z.string().nullable(),
    terms: z.string().nullable(),
    answer: z
      .object({
        status: z.enum(['accepted', 'rejected']),
        at: z.iso.datetime(),
        name: z.string().nullable(),
      })
      .nullable(),
  }),
  lines: z.array(documentLineSchema),
  totals: totalsSchema,
  /** Whether the customer may still accept or reject: issued and not expired. */
  canAnswer: z.boolean(),
});

/** The quote a token names, when it is this website's company's live link. */
async function quoteForToken(token: string, live: { tenantId: string }) {
  const found = await getPlatformDataSource().publicQuotes.byTokenHash(hashToken(token));
  if (found?.tenantId !== live.tenantId) {
    throw notFound('This link is not valid.');
  }
  const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(found.tenantId);
  if (brand === undefined) {
    throw notFound('This link is not valid.');
  }
  return { ...found, brand };
}

async function publicQuoteBody(
  tx: TenantTransaction,
  quoteId: string,
  brand: { name: string; slug: string; logoMediaId: string | null; brandColour: string | null },
): Promise<z.infer<typeof publicQuoteSchema>> {
  const quote = await tx.salesQuotes.findQuote(quoteId);
  if (quote === undefined) {
    throw notFound('This link is not valid.');
  }
  if (
    quote.customerName === null ||
    quote.customerAddress === null ||
    quote.issuedAt === null ||
    (quote.status !== 'issued' && quote.status !== 'accepted' && quote.status !== 'rejected')
  ) {
    throw notFound('This link is not valid.');
  }
  const [lines, totals, today] = await Promise.all([
    tx.salesQuotes.quoteLines(quote.id),
    tx.salesQuotes.quoteTotals(quote.id),
    companyToday(tx),
  ]);
  const expired = quote.status === 'issued' && quoteExpired(quote.validUntil, today);
  return {
    company: {
      name: brand.name,
      logoPath: brand.logoMediaId === null ? null : `/v1/public/companies/${brand.slug}/logo`,
      brandColour: brand.brandColour,
    },
    quote: {
      reference: formatQuoteReference(quote.reference, quote.revision),
      title: quote.title,
      status: quote.status,
      expired,
      currencyCode: quote.currencyCode,
      validUntil: quote.validUntil,
      issuedAt: iso(quote.issuedAt),
      customerName: quote.customerName,
      customerAddress: quote.customerAddress,
      contactName: quote.contactName,
      introduction: quote.introduction,
      terms: quote.terms,
      answer:
        quote.answeredAt === null
          ? null
          : {
              status: quote.status === 'rejected' ? 'rejected' : 'accepted',
              at: isoOrNull(quote.answeredAt)!,
              name: quote.answeredName,
            },
    },
    lines: lineBodies(lines),
    totals,
    canAnswer: quote.status === 'issued' && !expired,
  };
}

export const getPublicQuoteRoute = defineRoute({
  method: 'get',
  path: '/v1/website/quotes/by-token/:token',
  operationId: 'getWebsiteQuoteByToken',
  summary: 'An issued quote, for the company website page its customer link opens',
  description:
    'For a company’s website server, never a browser: `Authorization: Bearer <website key>`. The quote as issued — company, customer, lines, totals, terms, expiry — and whether it can still be answered. A link that is spent, revised, withdrawn, unknown or another company’s is 404. Needs website quote access on both sides and the sales module (403); rate-limited per key (429).',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  allowedWhenReadOnly: true,
  params: tokenParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The quote.', schema: publicQuoteSchema },
    401: { description: 'No website key, or not a live one (`website_key_invalid`).' },
    403: {
      description:
        'Website quote access or the sales module is off (`feature_disabled`), or the company has no website (`website_missing`).',
    },
    404: { description: 'This link is not valid.' },
    429: { description: 'Too many requests with this key; slow down.' },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const live = await authorizeWebsite(context, 'quotes');
    const { tenantId, quoteId, brand } = await quoteForToken(params.token, live);
    const body = await withTenant(tenantId, (tx) => publicQuoteBody(tx, quoteId, brand));
    return { status: 200, body, headers: { 'cache-control': 'no-store' } };
  },
});

export const answerPublicQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/website/quotes/by-token/:token/answer',
  operationId: 'answerWebsiteQuoteByToken',
  summary: 'Record the customer’s answer to a quote, from the company website',
  description:
    'For a company’s website server, never a browser: `Authorization: Bearer <website key>`. Records the customer’s answer with the name they typed and the moment, spends the link, and — for an acceptance — wins the quote’s opportunity. The address recorded is the website server’s. Refused once the quote has expired (409 `quote_expired`). Same switches and rate limit as reading it.',
  tags: TAGS,
  security: 'public',
  websiteKeyAuth: true,
  allowedWhenReadOnly: true,
  params: tokenParams,
  query: noSchema,
  body: z.object({
    status: z.enum(['accepted', 'rejected']),
    /** Who is answering, as they wish to be recorded. */
    name: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(1000).optional(),
  }),
  responses: {
    200: { description: 'The quote, answered.', schema: publicQuoteSchema },
    401: { description: 'No website key, or not a live one (`website_key_invalid`).' },
    403: {
      description:
        'Website quote access or the sales module is off (`feature_disabled`), or the company has no website (`website_missing`).',
    },
    404: { description: 'This link is not valid.' },
    409: {
      description:
        'The quote has expired (`quote_expired`) or is no longer open (`quote_not_issued`).',
    },
    429: { description: 'Too many requests with this key; slow down.' },
  },
  handler: async ({ params, body }, context: PublicRequestContext) => {
    const live = await authorizeWebsite(context, 'quotes');
    const { tenantId, quoteId, brand } = await quoteForToken(params.token, live);
    const result = await withTenant(tenantId, async (tx) => {
      const quote = await tx.salesQuotes.lockQuote(quoteId);
      if (quote === undefined) {
        throw notFound('This link is not valid.');
      }
      if (quote.status !== 'issued') {
        throw conflict('quote_not_issued', 'This quote is no longer open for an answer.');
      }
      if (quoteExpired(quote.validUntil, await companyToday(tx))) {
        throw conflict('quote_expired', 'This quote has expired. Ask the company for a new one.');
      }
      const answered = await tx.salesQuotes.answer(quote.id, {
        status: body.status,
        via: 'link',
        answeredBy: null,
        name: body.name,
        from: context.ipAddress,
        reason: body.reason ?? null,
      });
      if (typeof answered === 'string') {
        throw conflict('quote_not_issued', 'This quote is no longer open for an answer.');
      }
      const record = (
        action: string,
        resourceType: string,
        resourceId: string,
        metadata: Record<string, unknown>,
      ) =>
        tx.auditLog
          .append({
            actorKind: 'system',
            actorId: null,
            actorLabel: 'company-website',
            action,
            resourceType,
            resourceId,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata,
          })
          .then(() => undefined);
      await record(
        body.status === 'accepted' ? 'quote.accepted' : 'quote.rejected',
        'quote',
        answered.id,
        {
          reference: formatQuoteReference(answered.reference, answered.revision),
          via: 'link',
          name: body.name,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        },
      );
      if (body.status === 'accepted') {
        await winOpportunity(tx, answered, answered.issuedBy ?? answered.createdBy, record);
      }
      return publicQuoteBody(tx, answered.id, brand);
    });
    return { status: 200, body: result, headers: { 'cache-control': 'no-store' } };
  },
});

export const salesPublicRoutes = [getPublicQuoteRoute, answerPublicQuoteRoute];
