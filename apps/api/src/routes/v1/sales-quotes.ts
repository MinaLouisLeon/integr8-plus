import {
  currencyCodeSchema,
  discountBpSchema,
  formatQuoteReference,
  holds,
  opportunityEventKind,
  positiveQuantitySchema,
  type Principal,
  QUOTE_STATUSES,
  quoteAnswerable,
  quoteAnswerViaSchema,
  quoteExpired,
  quoteRevisable,
  quoteStatusSchema,
  taxRateSchema,
  unitSchema,
  decimalAmountSchema,
} from '@integr8/core';
import {
  type Quote,
  type QuoteLine,
  type QuoteLineInput,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  crmAudit as audit,
  decodeDateCursor,
  encodeDateCursor,
  versionConflict,
} from './crm-shared.js';
import {
  addressSchema,
  many,
  type People,
  peopleOf,
  personBody,
  personSchema,
} from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Quotes (CRM/ERP plan, phase S1; ADR-0006).
 *
 * A dispatcher drafts; an owner or admin issues, which freezes the customer
 * and the lines onto the document and mints the customer's link. The answer
 * is recorded by the office here or by the customer through the public route
 * (`sales-public.ts`). An accepted quote is converted into a sales order
 * exactly once (`sales-orders.ts`). Prices are decimal strings in the quote's
 * currency; discounts and tax rates are basis points per line; every total is
 * computed on the server from the lines.
 */

export const TAGS = ['sales'];
export const FEATURE = 'sales' as const;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const totalsSchema = z.object({
  gross: z.string(),
  discount: z.string(),
  net: z.string(),
  tax: z.string(),
  total: z.string(),
});

export const documentLineSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  itemId: z.uuid().nullable(),
  description: z.string(),
  quantity: z.string(),
  unit: unitSchema,
  unitPrice: z.string(),
  /** Basis points: 1450 is 14.5%. */
  discountBp: z.number().int(),
  taxRateBp: z.number().int(),
  gross: z.string(),
  discount: z.string(),
  net: z.string(),
  tax: z.string(),
  total: z.string(),
});

export const quoteSummarySchema = z.object({
  id: z.uuid(),
  /** `QT-000123`, or `QT-000123-R2` for a revision. */
  reference: z.string(),
  revision: z.number().int(),
  title: z.string(),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  status: quoteStatusSchema,
  /** True when the quote is issued and past its `validUntil`: it can no longer be answered. */
  expired: z.boolean(),
  currencyCode: z.string(),
  validUntil: z.iso.date().nullable(),
  totals: totalsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const quoteSchema = quoteSummarySchema.extend({
  site: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  contact: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  opportunity: z.object({ id: z.uuid(), title: z.string() }).nullable(),
  introduction: z.string().nullable(),
  terms: z.string().nullable(),
  /** Never shown to the customer; null to seats without `sales.manage`. */
  internalNotes: z.string().nullable(),
  /** The customer as the issued quote names them; null while a draft. */
  issuedTo: z
    .object({
      customerName: z.string(),
      customerAddress: addressSchema,
      contactName: z.string().nullable(),
      contactEmail: z.string().nullable(),
      contactPhone: z.string().nullable(),
    })
    .nullable(),
  issuedBy: personSchema.nullable(),
  issuedAt: z.iso.datetime().nullable(),
  /** Whether a customer link is live; the link itself comes back from `issue` only. */
  hasLink: z.boolean(),
  answer: z
    .object({
      status: z.enum(['accepted', 'rejected']),
      at: z.iso.datetime(),
      via: quoteAnswerViaSchema,
      by: personSchema.nullable(),
      name: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  convertedOrderId: z.uuid().nullable(),
  cancelledBy: personSchema.nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  createdBy: personSchema,
});

export const quoteDetailSchema = z.object({
  quote: quoteSchema,
  lines: z.array(documentLineSchema),
  can: z.object({
    edit: z.boolean(),
    issue: z.boolean(),
    revise: z.boolean(),
    answer: z.boolean(),
    convert: z.boolean(),
    cancel: z.boolean(),
  }),
});

/** Today in the company's calendar, as `YYYY-MM-DD`. */
export async function companyToday(tx: TenantTransaction, now = new Date()): Promise<string> {
  const { timezone } = await tx.settings.get();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function lineBodies(lines: readonly QuoteLine[]): z.infer<typeof documentLineSchema>[] {
  return lines.map((line) => ({
    id: line.id,
    position: line.position,
    itemId: line.itemId,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    discountBp: line.discountBp,
    taxRateBp: line.taxRateBp,
    gross: line.gross,
    discount: line.discount,
    net: line.net,
    tax: line.tax,
    total: line.total,
  }));
}

export async function quoteSummaries(
  tx: TenantTransaction,
  quotes: readonly Quote[],
  today: string,
): Promise<z.infer<typeof quoteSummarySchema>[]> {
  const customers = new Map(
    (await tx.customers.findMany([...new Set(quotes.map((quote) => quote.customerId))])).map(
      (customer) => [customer.id, customer],
    ),
  );
  const totals = await Promise.all(quotes.map((quote) => tx.salesQuotes.quoteTotals(quote.id)));
  return quotes.map((quote, index) => ({
    id: quote.id,
    reference: formatQuoteReference(quote.reference, quote.revision),
    revision: quote.revision,
    title: quote.title,
    customer: {
      id: quote.customerId,
      name: quote.customerName ?? customers.get(quote.customerId)?.name ?? '',
    },
    status: quote.status,
    expired: quote.status === 'issued' && quoteExpired(quote.validUntil, today),
    currencyCode: quote.currencyCode,
    validUntil: quote.validUntil,
    totals: totals[index]!,
    createdAt: iso(quote.createdAt),
    updatedAt: iso(quote.updatedAt),
  }));
}

export async function quoteDetail(
  tx: TenantTransaction,
  principal: Principal,
  quote: Quote,
  people?: People,
): Promise<z.infer<typeof quoteDetailSchema>> {
  const today = await companyToday(tx);
  const names = people ?? (await peopleOf(tx));
  const [summary, lines, site, contacts, opportunity] = await Promise.all([
    quoteSummaries(tx, [quote], today),
    tx.salesQuotes.quoteLines(quote.id),
    quote.siteId === null ? undefined : tx.sites.find(quote.siteId),
    quote.contactId === null ? [] : tx.customers.findContacts([quote.contactId]),
    quote.opportunityId === null ? undefined : tx.crmOpportunities.find(quote.opportunityId),
  ]);
  const manage = holds(principal, 'sales.manage');
  const expired = summary[0]!.expired;
  return {
    quote: {
      ...summary[0]!,
      site: site === undefined ? null : { id: site.id, name: site.name },
      contact: contacts[0] === undefined ? null : { id: contacts[0].id, name: contacts[0].name },
      opportunity:
        opportunity === undefined ? null : { id: opportunity.id, title: opportunity.title },
      introduction: quote.introduction,
      terms: quote.terms,
      internalNotes: manage ? quote.internalNotes : null,
      issuedTo:
        quote.customerName === null || quote.customerAddress === null
          ? null
          : {
              customerName: quote.customerName,
              customerAddress: quote.customerAddress,
              contactName: quote.contactName,
              contactEmail: quote.contactEmail,
              contactPhone: quote.contactPhone,
            },
      issuedBy: quote.issuedBy === null ? null : personBody(quote.issuedBy, names),
      issuedAt: isoOrNull(quote.issuedAt),
      hasLink: quote.hasToken,
      answer:
        quote.answeredAt === null || quote.answeredVia === null
          ? null
          : {
              status: quote.status === 'rejected' ? 'rejected' : 'accepted',
              at: iso(quote.answeredAt),
              via: quote.answeredVia,
              by: quote.answeredBy === null ? null : personBody(quote.answeredBy, names),
              name: quote.answeredName,
              reason: quote.rejectionReason,
            },
      convertedOrderId: quote.convertedOrderId,
      cancelledBy: quote.cancelledBy === null ? null : personBody(quote.cancelledBy, names),
      cancelledAt: isoOrNull(quote.cancelledAt),
      cancelReason: quote.cancelReason,
      version: quote.version,
      createdBy: personBody(quote.createdBy, names),
    },
    lines: lineBodies(lines),
    can: {
      edit: manage && quote.status === 'draft',
      issue: holds(principal, 'sales.issue') && quote.status === 'draft' && lines.length > 0,
      revise: manage && (quoteRevisable(quote.status) || (quote.status === 'issued' && expired)),
      answer: manage && quoteAnswerable(quote.status) && !expired,
      convert: manage && quote.status === 'accepted',
      cancel:
        manage &&
        quote.status !== 'converted' &&
        quote.status !== 'cancelled' &&
        quote.status !== 'accepted',
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const lineInputSchema = z.object({
  /** A catalogue item; without one the line is written by hand. */
  itemId: z.uuid().nullable().optional(),
  /** Defaults to the item's name. */
  description: z.string().trim().min(1).max(500).optional(),
  quantity: positiveQuantitySchema,
  /** Defaults to the item's unit, else `each`. */
  unit: unitSchema.optional(),
  /** Defaults to the item's sale price, else 0. */
  unitPrice: decimalAmountSchema.optional(),
  discountBp: discountBpSchema.optional(),
  taxRateBp: taxRateSchema.optional(),
});

const quoteFields = {
  customerId: z.uuid(),
  siteId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  opportunityId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  validUntil: z.iso.date().nullable().optional(),
  introduction: z.string().max(4000).nullable().optional(),
  terms: z.string().max(10_000).nullable().optional(),
  internalNotes: z.string().max(10_000).nullable().optional(),
};

/** The lines as the repository takes them, each item checked and its defaults filled in. */
export async function documentLineInputs(
  tx: TenantTransaction,
  lines: readonly z.infer<typeof lineInputSchema>[],
): Promise<QuoteLineInput[]> {
  const itemIds = lines.flatMap((line) => (line.itemId == null ? [] : [line.itemId]));
  const items = new Map(
    (await tx.inventoryCatalogue.findItems(itemIds)).map((item) => [item.id, item]),
  );
  return lines.map((line, index) => {
    const item = line.itemId == null ? undefined : items.get(line.itemId);
    if (line.itemId != null && item?.archivedAt !== null) {
      throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
        {
          field: `body.lines.${index}.itemId`,
          code: 'item_not_found',
          message: item === undefined ? 'This item does not exist.' : 'This item is archived.',
        },
      ]);
    }
    const description = line.description ?? item?.name;
    if (description === undefined) {
      throw unprocessable('description_required', 'A line without an item needs a description.', [
        {
          field: `body.lines.${index}.description`,
          code: 'description_required',
          message: 'Describe the line.',
        },
      ]);
    }
    return {
      itemId: item?.id ?? null,
      description,
      quantity: line.quantity,
      unit: line.unit ?? item?.unit ?? 'each',
      unitPrice: line.unitPrice ?? item?.salePrice ?? '0',
      ...(line.discountBp === undefined ? {} : { discountBp: line.discountBp }),
      ...(line.taxRateBp === undefined ? {} : { taxRateBp: line.taxRateBp }),
    };
  });
}

/** The customer, and the site, contact and opportunity named must be theirs. */
export async function requireCustomerParties(
  tx: TenantTransaction,
  input: {
    customerId: string;
    siteId?: string | null | undefined;
    contactId?: string | null | undefined;
    opportunityId?: string | null | undefined;
  },
) {
  const customer = await tx.customers.find(input.customerId);
  if (customer === undefined) {
    throw new ApiError(404, 'customer_not_found', 'This customer does not exist.', [
      { field: 'body.customerId', code: 'customer_not_found', message: 'Choose a customer.' },
    ]);
  }
  if (typeof input.siteId === 'string') {
    const site = await tx.sites.find(input.siteId);
    if (site?.customerId !== customer.id || site.archivedAt !== null) {
      throw unprocessable('site_not_customers', 'The site must be one of the customer’s sites.', [
        { field: 'body.siteId', code: 'site_not_customers', message: 'Choose one of their sites.' },
      ]);
    }
  }
  if (typeof input.contactId === 'string') {
    const [contact] = await tx.customers.findContacts([input.contactId]);
    if (contact?.customerId !== customer.id || contact.archivedAt !== null) {
      throw unprocessable(
        'contact_not_customers',
        'The contact must be one of the customer’s contacts.',
        [
          {
            field: 'body.contactId',
            code: 'contact_not_customers',
            message: 'Choose one of their contacts.',
          },
        ],
      );
    }
  }
  if (typeof input.opportunityId === 'string') {
    const opportunity = await tx.crmOpportunities.find(input.opportunityId);
    if (opportunity?.customerId !== customer.id) {
      throw unprocessable(
        'opportunity_not_customers',
        'The opportunity must be one of the customer’s.',
        [
          {
            field: 'body.opportunityId',
            code: 'opportunity_not_customers',
            message: 'Choose one of their opportunities.',
          },
        ],
      );
    }
  }
  return customer;
}

const quoteParams = z.object({ quoteId: z.uuid() });

async function requireQuote(tx: TenantTransaction, quoteId: string): Promise<Quote> {
  const quote = await tx.salesQuotes.lockQuote(quoteId);
  if (quote === undefined) {
    throw notFound('This quote does not exist.');
  }
  return quote;
}

function quoteRefusal(result: 'not_found' | 'version_conflict' | 'not_draft'): never {
  if (result === 'not_found') {
    throw notFound('This quote does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('quote_not_draft', 'Only a draft changes. Revise this quote to edit it.');
}

/** A fresh link token and the hash the database keeps (ADR-0006). */
export function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The customer's link, when the API knows where the web app lives. */
export function acceptUrl(context: RequestContext, token: string): string | null {
  const base = context.config.WEB_APP_URL;
  return base === undefined ? null : `${base.replace(/\/+$/u, '')}/q/${token}`;
}

/**
 * Marks the quote's opportunity won when the customer accepts, through the
 * pipeline's own won stage — the same move the CRM screen makes, audited the
 * same way. An opportunity already closed is left as it is. The actor is the
 * seat that recorded the answer, or the issuer when the customer answered
 * through their link.
 */
export async function winOpportunity(
  tx: TenantTransaction,
  quote: Quote,
  actorId: string,
  record: (
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) => Promise<void>,
): Promise<void> {
  if (quote.opportunityId === null) {
    return;
  }
  const opportunity = await tx.crmOpportunities.find(quote.opportunityId);
  if (opportunity?.status !== 'open' || opportunity.archivedAt !== null) {
    return;
  }
  const stages = await tx.crmPipelines.stages(opportunity.pipelineId);
  const from = stages.find((stage) => stage.id === opportunity.stageId);
  const to = stages.find((stage) => stage.outcome === 'won' && stage.archivedAt === null);
  if (from === undefined || to === undefined) {
    return;
  }
  const moved = await tx.crmOpportunities.move(opportunity.id, opportunity.version, {
    from,
    to,
    kind: opportunityEventKind(from.outcome, to.outcome),
    lostReason: null,
    actorId,
  });
  if (typeof moved !== 'string') {
    await record('crm_opportunity.won_by_quote', 'crm_opportunity', opportunity.id, {
      quoteId: quote.id,
      reference: formatQuoteReference(quote.reference, quote.revision),
    });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const listQuotesRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/quotes',
  operationId: 'listQuotes',
  summary: 'Find quotes',
  description:
    'Newest first, a page at a time. `q` matches a reference (`QT-000123`, `123`) or words of the title or customer name.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(quoteStatusSchema, QUOTE_STATUSES.length),
    customerId: z.uuid().optional(),
    opportunityId: z.uuid().optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of quotes.',
      schema: z.object({ items: z.array(quoteSummarySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.salesQuotes.listQuotes({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.opportunityId === undefined ? {} : { opportunityId: query.opportunityId }),
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await quoteSummaries(tx, page.items, await companyToday(tx)),
        nextCursor: encodeDateCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const createQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/quotes',
  operationId: 'createQuote',
  summary: 'Draft a quote',
  description:
    "A draft in the company currency (or `currencyCode`), numbered `QT-000001` onwards. Lines may name catalogue items, taking the item's name, unit and sale price unless given. Honours `Idempotency-Key`.",
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    ...quoteFields,
    currencyCode: currencyCodeSchema.optional(),
    lines: z.array(lineInputSchema).max(200).default([]),
  }),
  responses: {
    201: { description: 'The quote.', schema: quoteDetailSchema },
    404: { description: 'No such customer (`customer_not_found`) or item (`item_not_found`).' },
    422: {
      description:
        'Invalid; the site, contact or opportunity is not the customer’s; a hand-written line without a description.',
    },
  },
  handler: async ({ body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      await requireCustomerParties(tx, body);
      const lines = await documentLineInputs(tx, body.lines);
      const quote = await tx.salesQuotes.createQuote(
        {
          customerId: body.customerId,
          siteId: body.siteId ?? null,
          contactId: body.contactId ?? null,
          opportunityId: body.opportunityId ?? null,
          title: body.title,
          currencyCode: body.currencyCode ?? (await tx.settings.get()).currency,
          validUntil: body.validUntil ?? null,
          introduction: body.introduction ?? null,
          terms: body.terms ?? null,
          internalNotes: body.internalNotes ?? null,
        },
        lines,
        context.principal.userId,
      );
      await audit(tx, context, 'quote.created', 'quote', quote.id, {
        reference: formatQuoteReference(quote.reference),
        customerId: quote.customerId,
        lines: lines.length,
      });
      return quoteDetail(tx, context.principal, quote);
    });
    return { status: 201, body: detail };
  },
});

export const getQuoteRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/quotes/:quoteId',
  operationId: 'getQuote',
  summary: 'Read a quote',
  description: 'The quote, its lines and totals, its answer, and what this seat may do.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: quoteParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The quote.', schema: quoteDetailSchema },
    404: { description: 'No such quote.' },
  },
  handler: async ({ params }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const quote = await tx.salesQuotes.findQuote(params.quoteId);
      if (quote === undefined) {
        throw notFound('This quote does not exist.');
      }
      return quoteDetail(tx, context.principal, quote);
    });
    return { status: 200, body: detail };
  },
});

export const updateQuoteRoute = defineRoute({
  method: 'patch',
  path: '/v1/sales/quotes/:quoteId',
  operationId: 'updateQuote',
  summary: 'Change a draft quote',
  description:
    'Send `expectedVersion` as read. `lines`, when sent, replaces every line. Only a draft changes (409 `quote_not_draft`); revise an issued quote first.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: quoteParams,
  query: noSchema,
  body: z
    .object({
      ...quoteFields,
      customerId: quoteFields.customerId.optional(),
      title: quoteFields.title.optional(),
      lines: z.array(lineInputSchema).max(200).optional(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  responses: {
    200: { description: 'The quote as it is now.', schema: quoteDetailSchema },
    404: { description: 'No such quote, customer or item.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`) or not a draft (`quote_not_draft`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await requireQuote(tx, params.quoteId);
      await requireCustomerParties(tx, {
        customerId: body.customerId ?? current.customerId,
        siteId: body.siteId ?? (body.customerId === undefined ? undefined : null),
        contactId: body.contactId ?? (body.customerId === undefined ? undefined : null),
        opportunityId: body.opportunityId ?? (body.customerId === undefined ? undefined : null),
      });
      const lines = body.lines === undefined ? undefined : await documentLineInputs(tx, body.lines);
      const result = await tx.salesQuotes.updateDraft(
        current.id,
        body.expectedVersion,
        {
          ...(body.customerId === undefined
            ? {}
            : // A new customer drops the old customer's site, contact and opportunity unless re-given.
              {
                customerId: body.customerId,
                siteId: body.siteId ?? null,
                contactId: body.contactId ?? null,
                opportunityId: body.opportunityId ?? null,
              }),
          ...(body.customerId !== undefined || body.siteId === undefined
            ? {}
            : { siteId: body.siteId }),
          ...(body.customerId !== undefined || body.contactId === undefined
            ? {}
            : { contactId: body.contactId }),
          ...(body.customerId !== undefined || body.opportunityId === undefined
            ? {}
            : { opportunityId: body.opportunityId }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.validUntil === undefined ? {} : { validUntil: body.validUntil }),
          ...(body.introduction === undefined ? {} : { introduction: body.introduction }),
          ...(body.terms === undefined ? {} : { terms: body.terms }),
          ...(body.internalNotes === undefined ? {} : { internalNotes: body.internalNotes }),
        },
        lines,
      );
      if (typeof result === 'string') {
        quoteRefusal(result);
      }
      await audit(tx, context, 'quote.updated', 'quote', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
        version: result.version,
      });
      return quoteDetail(tx, context.principal, result);
    });
    return { status: 200, body: detail };
  },
});

const versionBody = z.object({ expectedVersion: z.number().int().positive() });

export const issueQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/quotes/:quoteId/issue',
  operationId: 'issueQuote',
  summary: 'Issue a quote to the customer',
  description:
    "Owners and admins issue. Freezes the customer's name and address and the lines onto the quote, and mints the customer's link, returned once here (`acceptUrl`, when the web app's address is configured; `acceptToken` always). An empty draft cannot be issued (422 `quote_empty`).",
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.issue',
  feature: FEATURE,
  params: quoteParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: {
      description: 'The quote, issued, with its customer link.',
      schema: quoteDetailSchema.extend({
        acceptToken: z.string(),
        acceptUrl: z.string().nullable(),
      }),
    },
    404: { description: 'No such quote.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`) or not a draft (`quote_not_draft`).',
    },
    422: { description: 'No lines (`quote_empty`).' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const quote = await requireQuote(tx, params.quoteId);
      if (quote.status !== 'draft') {
        quoteRefusal('not_draft');
      }
      if ((await tx.salesQuotes.quoteLines(quote.id)).length === 0) {
        throw unprocessable('quote_empty', 'Add at least one line before issuing.');
      }
      const customer = await requireCustomerParties(tx, quote);
      const [contact] =
        quote.contactId === null ? [] : await tx.customers.findContacts([quote.contactId]);
      const { token, hash } = mintToken();
      const issued = await tx.salesQuotes.issue(quote.id, body.expectedVersion, {
        issuedBy: context.principal.userId,
        snapshot: {
          customerName: customer.name,
          customerAddress: customer.address,
          contactName: contact?.name ?? null,
          contactEmail: contact?.email ?? customer.email,
          contactPhone: contact?.phone ?? customer.phone,
        },
        tokenHash: hash,
      });
      if (typeof issued === 'string') {
        quoteRefusal(issued);
      }
      await audit(tx, context, 'quote.issued', 'quote', issued.id, {
        reference: formatQuoteReference(issued.reference, issued.revision),
        validUntil: issued.validUntil,
      });
      return {
        ...(await quoteDetail(tx, context.principal, issued)),
        acceptToken: token,
        acceptUrl: acceptUrl(context, token),
      };
    });
    return { status: 200, body: result };
  },
});

export const reviseQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/quotes/:quoteId/revise',
  operationId: 'reviseQuote',
  summary: 'Revise an issued quote',
  description:
    'Makes a new draft revision under the same reference (`QT-000123-R2`). The old link stops working. Allowed for an issued, expired or rejected quote; not for one accepted, converted or cancelled (409 `quote_not_revisable`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: quoteParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: { description: 'The new draft revision.', schema: quoteDetailSchema },
    404: { description: 'No such quote.' },
    409: { description: 'Changed by somebody else or not revisable (`quote_not_revisable`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const quote = await requireQuote(tx, params.quoteId);
      if (!quoteRevisable(quote.status)) {
        throw conflict('quote_not_revisable', 'Only an issued or rejected quote is revised.');
      }
      const revised = await tx.salesQuotes.revise(quote.id, body.expectedVersion);
      if (typeof revised === 'string') {
        quoteRefusal(revised);
      }
      await audit(tx, context, 'quote.revised', 'quote', revised.id, {
        reference: formatQuoteReference(revised.reference, revised.revision),
      });
      return quoteDetail(tx, context.principal, revised);
    });
    return { status: 200, body: detail };
  },
});

export const answerQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/quotes/:quoteId/answer',
  operationId: 'answerQuote',
  summary: "Record the customer's answer",
  description:
    'The office records that the customer accepted or rejected an issued quote, with who said so. Accepting wins the linked opportunity. An expired quote is not answered (409 `quote_expired`); revise it.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: quoteParams,
  query: noSchema,
  body: versionBody.extend({
    status: z.enum(['accepted', 'rejected']),
    /** Who at the customer answered. */
    name: z.string().trim().max(200).nullable().optional(),
    reason: z.string().trim().max(1000).nullable().optional(),
  }),
  responses: {
    200: { description: 'The quote, answered.', schema: quoteDetailSchema },
    404: { description: 'No such quote.' },
    409: {
      description:
        'Changed by somebody else, not issued (`quote_not_issued`), or expired (`quote_expired`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const quote = await requireQuote(tx, params.quoteId);
      if (!quoteAnswerable(quote.status)) {
        throw conflict('quote_not_issued', 'Only an issued quote is answered.');
      }
      if (quoteExpired(quote.validUntil, await companyToday(tx))) {
        throw conflict('quote_expired', 'This quote has expired. Revise and issue it again.');
      }
      const answered = await tx.salesQuotes.answer(
        quote.id,
        {
          status: body.status,
          via: 'office',
          answeredBy: context.principal.userId,
          name: body.name ?? null,
          from: null,
          reason: body.reason ?? null,
        },
        body.expectedVersion,
      );
      if (typeof answered === 'string') {
        quoteRefusal(answered);
      }
      await audit(tx, context, `quote.${body.status}`, 'quote', answered.id, {
        reference: formatQuoteReference(answered.reference, answered.revision),
        via: 'office',
        name: body.name ?? null,
      });
      if (body.status === 'accepted') {
        await winOpportunity(
          tx,
          answered,
          context.principal.userId,
          (action, resourceType, resourceId, metadata) =>
            audit(tx, context, action, resourceType, resourceId, metadata),
        );
      }
      return quoteDetail(tx, context.principal, answered);
    });
    return { status: 200, body: detail };
  },
});

export const cancelQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/quotes/:quoteId/cancel',
  operationId: 'cancelQuote',
  summary: 'Withdraw a quote',
  description:
    'A draft, issued or rejected quote is withdrawn with an optional reason; its link stops working. An accepted quote is converted or revised, not cancelled (409 `quote_closed`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: quoteParams,
  query: noSchema,
  body: versionBody.extend({ reason: z.string().trim().max(1000).nullable().optional() }),
  responses: {
    200: { description: 'The quote, cancelled.', schema: quoteDetailSchema },
    404: { description: 'No such quote.' },
    409: { description: 'Changed by somebody else or closed (`quote_closed`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const quote = await requireQuote(tx, params.quoteId);
      if (['accepted', 'converted', 'cancelled'].includes(quote.status)) {
        throw conflict('quote_closed', 'This quote is no longer open.');
      }
      const cancelled = await tx.salesQuotes.cancel(
        quote.id,
        body.expectedVersion,
        context.principal.userId,
        body.reason ?? null,
      );
      if (typeof cancelled === 'string') {
        quoteRefusal(cancelled);
      }
      await audit(tx, context, 'quote.cancelled', 'quote', cancelled.id, {
        reference: formatQuoteReference(cancelled.reference, cancelled.revision),
        reason: body.reason ?? null,
      });
      return quoteDetail(tx, context.principal, cancelled);
    });
    return { status: 200, body: detail };
  },
});

export const quoteRoutes = [
  listQuotesRoute,
  createQuoteRoute,
  getQuoteRoute,
  updateQuoteRoute,
  issueQuoteRoute,
  reviseQuoteRoute,
  answerQuoteRoute,
  cancelQuoteRoute,
];
