import { formatQuoteReference, quoteExpired } from '@integr8/core';
import { getPlatformDataSource, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { defineRoute, noSchema, type PublicRequestContext } from '../../http/routes.js';
import { fill, messageLocale, wordsFor } from '../../notifications/words.js';
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

/**
 * The customer's view of a quote (CRM/ERP plan, phase S1; ADR-0006).
 *
 * The link `/q/<token>` the office copied opens here. The token is a 256-bit
 * capability: whoever holds it reads the issued quote and may accept or
 * reject it until the quote's expiry, with no account and no session. It
 * exposes the quote and the company's name and logo, and nothing else: no
 * internal notes, no ids, no people. A token that is spent, revised,
 * cancelled or never existed answers 404 alike, so a stranger learns nothing
 * from guessing. The server's per-address rate limit covers these routes as
 * it covers every other.
 *
 * **With the company's sales module switched off** (Low 13, 1.2.4) a link that
 * would otherwise open answers 410 `quote_unavailable` instead — "no longer
 * available online, contact <company>", in English or Arabic by
 * `Accept-Language`, with the company's name in the details for a page that
 * writes its own words. Nothing is changed: switching sales back on restores
 * the link, which then answers as it always did (expired, answered, or open).
 * A link that is spent, revised or withdrawn stays the same 404 either way.
 */

const TAGS = ['sales'];

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

async function quoteForToken(token: string, context: PublicRequestContext) {
  const found = await getPlatformDataSource().publicQuotes.byTokenHash(hashToken(token));
  if (found === undefined) {
    throw notFound('This link is not valid.');
  }
  const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(found.tenantId);
  if (brand === undefined) {
    throw notFound('This link is not valid.');
  }
  if (!(await isFeatureEnabled(found.tenantId, 'sales'))) {
    // Only a link that would open says so; one that is no longer real stays
    // a 404, and does not name the company to whoever holds it.
    const quote = await withTenant(found.tenantId, (tx) => tx.salesQuotes.findQuote(found.quoteId));
    const opens =
      quote?.issuedAt != null && ['issued', 'accepted', 'rejected'].includes(quote.status);
    if (!opens) {
      throw notFound('This link is not valid.');
    }
    throw quoteUnavailable(brand.name, context.acceptLanguage ?? null);
  }
  return { ...found, brand };
}

/** 410 `quote_unavailable`, in the reader's language, naming the company. */
function quoteUnavailable(company: string, acceptLanguage: string | null): ApiError {
  const words = wordsFor(messageLocale(acceptLanguage)).publicQuote;
  return new ApiError(410, 'quote_unavailable', fill(words.unavailable, { company }), [
    {
      field: 'company',
      code: 'quote_unavailable',
      message: company,
      params: { company },
    },
  ]);
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
  path: '/v1/public/quotes/:token',
  operationId: 'getPublicQuote',
  summary: 'An issued quote, for the customer holding its link',
  description:
    'Public. The quote as issued — company, customer, lines, totals, terms, expiry — and whether it can still be answered. A link that is spent, revised, withdrawn or unknown is 404.',
  tags: TAGS,
  security: 'public',
  params: tokenParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The quote.', schema: publicQuoteSchema },
    404: { description: 'This link is not valid.' },
    410: {
      description:
        'The company’s sales module is switched off, so the quote is no longer available online (`quote_unavailable`; `details[0].params.company` names the company).',
    },
  },
  handler: async ({ params }, context: PublicRequestContext) => {
    const { tenantId, quoteId, brand } = await quoteForToken(params.token, context);
    const body = await withTenant(tenantId, (tx) => publicQuoteBody(tx, quoteId, brand));
    return { status: 200, body, headers: { 'cache-control': 'no-store' } };
  },
});

export const answerPublicQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/public/quotes/:token/answer',
  operationId: 'answerPublicQuote',
  summary: 'Accept or reject a quote through its link',
  description:
    'Public. Records the customer’s answer with the name they typed and the moment, spends the link, and — for an acceptance — wins the quote’s opportunity. Refused once the quote has expired (409 `quote_expired`).',
  tags: TAGS,
  security: 'public',
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
    404: { description: 'This link is not valid.' },
    409: {
      description:
        'The quote has expired (`quote_expired`) or is no longer open (`quote_not_issued`).',
    },
    410: {
      description:
        'The company’s sales module is switched off, so the quote cannot be answered online (`quote_unavailable`).',
    },
  },
  handler: async ({ params, body }, context: PublicRequestContext) => {
    const { tenantId, quoteId, brand } = await quoteForToken(params.token, context);
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
            actorLabel: 'customer-link',
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
