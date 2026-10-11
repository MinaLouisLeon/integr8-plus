import {
  currencyCodeSchema,
  formatQuoteReference,
  formatSalesOrderReference,
  holds,
  type Principal,
  SALES_ORDER_STATUSES,
  salesOrderOpen,
  salesOrderStatusSchema,
} from '@integr8/core';
import {
  type SalesOrder,
  type SalesOrderLine,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  crmAudit as audit,
  decodeDateCursor,
  encodeDateCursor,
  versionConflict,
} from './crm-shared.js';
import { requireLocation } from './inventory-stock.js';
import { itemSummary, itemSummarySchema } from './inventory.js';
import {
  addressSchema,
  many,
  type People,
  peopleOf,
  personBody,
  personSchema,
  workOrderSummaries,
  workOrderSummarySchema,
} from './operations.js';
import {
  documentLineInputs,
  documentLineSchema,
  FEATURE,
  lineInputSchema,
  requireCustomerParties,
  TAGS,
  totalsSchema,
} from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';
import { createWorkOrder, workOrderInputSchema } from './work-orders.js';

/**
 * Sales orders (CRM/ERP plan, phase S1; ADR-0006).
 *
 * An accepted quote is converted into an order exactly once; an order may
 * also be drafted directly. A dispatcher drafts and links or creates the
 * jobs that deliver it; an owner or admin confirms it, which freezes the
 * customer and the lines and reserves each stock line at one location —
 * what is there is held, the rest is flagged to order. Parts used on linked
 * jobs and the completion of linked jobs deliver the lines
 * (`sales-fulfilment.ts`).
 */

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const salesOrderLineSchema = documentLineSchema.extend({
  /** Held for this line at `reserveLocation` while the order is open. */
  quantityReserved: z.string(),
  /** Delivered: parts used on linked jobs, or the linked job that did the work completed. */
  quantityFulfilled: z.string(),
  /** Neither held nor delivered: what to order. */
  shortfall: z.string(),
  reserveLocation: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** Whether this is stock (held and delivered by parts) or delivered by the job itself. */
  stock: z.boolean(),
});

export const salesOrderSummarySchema = z.object({
  id: z.uuid(),
  /** `SO-000123`. */
  reference: z.string(),
  title: z.string(),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  status: salesOrderStatusSchema,
  currencyCode: z.string(),
  quote: z.object({ id: z.uuid(), reference: z.string() }).nullable(),
  totals: totalsSchema,
  /** Whether any stock line is short of what the location could hold for it. */
  toOrder: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const salesOrderSchema = salesOrderSummarySchema.extend({
  site: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  contact: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  notes: z.string().nullable(),
  /** Never shown to the customer; null to seats without `sales.manage`. */
  internalNotes: z.string().nullable(),
  reserveLocation: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** The customer as the confirmed order names them; null while a draft. */
  confirmedTo: z.object({ customerName: z.string(), customerAddress: addressSchema }).nullable(),
  confirmedBy: personSchema.nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  fulfilledAt: z.iso.datetime().nullable(),
  cancelledBy: personSchema.nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  createdBy: personSchema,
});

export const salesOrderDetailSchema = z.object({
  order: salesOrderSchema,
  lines: z.array(salesOrderLineSchema),
  /** The jobs that deliver it, oldest link first. */
  workOrders: z.array(workOrderSummarySchema),
  can: z.object({
    edit: z.boolean(),
    confirm: z.boolean(),
    /** Re-run the reservation, after goods arrived or to hold stock elsewhere. */
    reserve: z.boolean(),
    cancel: z.boolean(),
    linkJobs: z.boolean(),
    createJobs: z.boolean(),
  }),
});

async function lineBodies(
  tx: TenantTransaction,
  lines: readonly SalesOrderLine[],
): Promise<z.infer<typeof salesOrderLineSchema>[]> {
  const [items, locations] = await Promise.all([
    tx.inventoryCatalogue.findItems(
      lines.flatMap((line) => (line.itemId === null ? [] : [line.itemId])),
    ),
    tx.inventoryStock.findLocations(
      lines.flatMap((line) => (line.reserveLocationId === null ? [] : [line.reserveLocationId])),
    ),
  ]);
  const kind = new Map(items.map((item) => [item.id, item.kind]));
  const place = new Map(locations.map((location) => [location.id, location]));
  return lines.map((line) => {
    const where = line.reserveLocationId === null ? undefined : place.get(line.reserveLocationId);
    return {
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
      quantityReserved: line.quantityReserved,
      quantityFulfilled: line.quantityFulfilled,
      shortfall: line.shortfall,
      reserveLocation: where === undefined ? null : { id: where.id, name: where.name },
      stock: line.itemId !== null && kind.get(line.itemId) === 'stock_item',
    };
  });
}

export async function orderSummaries(
  tx: TenantTransaction,
  orders: readonly SalesOrder[],
): Promise<z.infer<typeof salesOrderSummarySchema>[]> {
  const [customers, quotes] = await Promise.all([
    tx.customers.findMany([...new Set(orders.map((order) => order.customerId))]),
    tx.salesQuotes.findQuotes(
      orders.flatMap((order) => (order.quoteId === null ? [] : [order.quoteId])),
    ),
  ]);
  const customer = new Map(customers.map((row) => [row.id, row]));
  const quote = new Map(quotes.map((row) => [row.id, row]));
  const lines = await Promise.all(orders.map((order) => tx.salesOrders.orderLines(order.id)));
  const totals = await Promise.all(orders.map((order) => tx.salesOrders.orderTotals(order.id)));
  const shaped = await Promise.all(lines.map((rows) => lineBodies(tx, rows)));
  return orders.map((order, index) => {
    const from = order.quoteId === null ? undefined : quote.get(order.quoteId);
    return {
      id: order.id,
      reference: formatSalesOrderReference(order.reference),
      title: order.title,
      customer: {
        id: order.customerId,
        name: order.customerName ?? customer.get(order.customerId)?.name ?? '',
      },
      status: order.status,
      currencyCode: order.currencyCode,
      quote:
        from === undefined
          ? null
          : { id: from.id, reference: formatQuoteReference(from.reference, from.revision) },
      totals: totals[index]!,
      toOrder:
        salesOrderOpen(order.status) &&
        shaped[index]!.some((line) => line.stock && line.shortfall !== '0'),
      createdAt: iso(order.createdAt),
      updatedAt: iso(order.updatedAt),
    };
  });
}

export async function orderDetail(
  tx: TenantTransaction,
  principal: Principal,
  order: SalesOrder,
  people?: People,
): Promise<z.infer<typeof salesOrderDetailSchema>> {
  const names = people ?? (await peopleOf(tx));
  const [summary, lines, site, contacts, location, links] = await Promise.all([
    orderSummaries(tx, [order]),
    tx.salesOrders.orderLines(order.id),
    order.siteId === null ? undefined : tx.sites.find(order.siteId),
    order.contactId === null ? [] : tx.customers.findContacts([order.contactId]),
    order.reserveLocationId === null
      ? undefined
      : tx.inventoryStock.findLocation(order.reserveLocationId),
    tx.salesOrders.workOrderLinks(order.id),
  ]);
  const jobs = await tx.workOrders.findMany(links.map((link) => link.workOrderId));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const ordered = links.flatMap((link) => {
    const job = byId.get(link.workOrderId);
    return job === undefined ? [] : [job];
  });
  const manage = holds(principal, 'sales.manage');
  const open = salesOrderOpen(order.status);
  return {
    order: {
      ...summary[0]!,
      site: site === undefined ? null : { id: site.id, name: site.name },
      contact: contacts[0] === undefined ? null : { id: contacts[0].id, name: contacts[0].name },
      notes: order.notes,
      internalNotes: manage ? order.internalNotes : null,
      reserveLocation: location === undefined ? null : { id: location.id, name: location.name },
      confirmedTo:
        order.customerName === null || order.customerAddress === null
          ? null
          : { customerName: order.customerName, customerAddress: order.customerAddress },
      confirmedBy: order.confirmedBy === null ? null : personBody(order.confirmedBy, names),
      confirmedAt: isoOrNull(order.confirmedAt),
      fulfilledAt: isoOrNull(order.fulfilledAt),
      cancelledBy: order.cancelledBy === null ? null : personBody(order.cancelledBy, names),
      cancelledAt: isoOrNull(order.cancelledAt),
      cancelReason: order.cancelReason,
      version: order.version,
      createdBy: personBody(order.createdBy, names),
    },
    lines: await lineBodies(tx, lines),
    workOrders: await workOrderSummaries(tx, ordered, names),
    can: {
      edit: manage && order.status === 'draft',
      confirm: holds(principal, 'sales.issue') && order.status === 'draft' && lines.length > 0,
      reserve: manage && open && lines.some((line) => line.itemId !== null),
      cancel: order.status === 'draft' ? manage : open && holds(principal, 'sales.issue'),
      linkJobs: manage && order.status !== 'cancelled' && order.status !== 'fulfilled',
      createJobs:
        manage &&
        holds(principal, 'work_order.manage') &&
        order.status !== 'cancelled' &&
        order.status !== 'fulfilled',
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs and helpers
// ---------------------------------------------------------------------------

const orderFields = {
  customerId: z.uuid(),
  siteId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).nullable().optional(),
  internalNotes: z.string().max(10_000).nullable().optional(),
};

const orderParams = z.object({ orderId: z.uuid() });

async function requireOrder(tx: TenantTransaction, orderId: string): Promise<SalesOrder> {
  const order = await tx.salesOrders.lockOrder(orderId);
  if (order === undefined) {
    throw notFound('This sales order does not exist.');
  }
  return order;
}

function orderRefusal(result: 'not_found' | 'version_conflict' | 'not_draft'): never {
  if (result === 'not_found') {
    throw notFound('This sales order does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('order_not_draft', 'Only a draft changes.');
}

/** Whether any line is a stock item: the lines that need a location to be held at. */
async function hasStockLines(tx: TenantTransaction, lines: readonly SalesOrderLine[]) {
  const items = await tx.inventoryCatalogue.findItems(
    lines.flatMap((line) => (line.itemId === null ? [] : [line.itemId])),
  );
  return items.some((item) => item.kind === 'stock_item');
}

/**
 * Runs the reservation at the location, which must exist and be current, and
 * audits what each stock line holds and lacks.
 */
async function reserveAt(
  tx: TenantTransaction,
  context: RequestContext,
  order: SalesOrder,
  locationId: string,
  action: string,
) {
  const location = await requireLocation(tx, locationId, 'body.reserveLocationId');
  if (location.archivedAt !== null) {
    throw unprocessable('location_archived', 'This location is archived.', [
      {
        field: 'body.reserveLocationId',
        code: 'location_archived',
        message: 'Choose a current location.',
      },
    ]);
  }
  const lines = await tx.salesOrders.reserve(order.id, location.id);
  await audit(tx, context, action, 'sales_order', order.id, {
    reference: formatSalesOrderReference(order.reference),
    locationId: location.id,
    short: lines
      .filter((line) => line.shortfall !== '0' && line.itemId !== null)
      .map((line) => ({ lineId: line.id, itemId: line.itemId, shortfall: line.shortfall })),
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const listSalesOrdersRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/orders',
  operationId: 'listSalesOrders',
  summary: 'Find sales orders',
  description:
    'Newest first, a page at a time. `q` matches a reference (`SO-000123`, `123`) or words of the title or customer name.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(salesOrderStatusSchema, SALES_ORDER_STATUSES.length),
    customerId: z.uuid().optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of sales orders.',
      schema: z.object({
        items: z.array(salesOrderSummarySchema),
        nextCursor: z.string().nullable(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.salesOrders.listOrders({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await orderSummaries(tx, page.items),
        nextCursor: encodeDateCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const createSalesOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/orders',
  operationId: 'createSalesOrder',
  summary: 'Draft a sales order',
  description:
    "A draft in the company currency (or `currencyCode`), numbered `SO-000001` onwards, without a quote. Lines may name catalogue items, taking the item's name, unit and sale price unless given. Honours `Idempotency-Key`.",
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    ...orderFields,
    currencyCode: currencyCodeSchema.optional(),
    lines: z.array(lineInputSchema).max(200).default([]),
  }),
  responses: {
    201: { description: 'The sales order.', schema: salesOrderDetailSchema },
    404: { description: 'No such customer or item.' },
    422: {
      description:
        'The site or contact is not the customer’s; a hand-written line has no description.',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      await requireCustomerParties(tx, body);
      const lines = await documentLineInputs(tx, body.lines);
      const currencyCode = body.currencyCode ?? (await tx.settings.get()).currency;
      const order = await tx.salesOrders.createOrder(
        {
          customerId: body.customerId,
          siteId: body.siteId ?? null,
          contactId: body.contactId ?? null,
          title: body.title,
          currencyCode,
          notes: body.notes ?? null,
          internalNotes: body.internalNotes ?? null,
        },
        lines,
        principal.userId,
      );
      await audit(tx, context, 'sales_order.created', 'sales_order', order.id, {
        reference: formatSalesOrderReference(order.reference),
        lines: lines.length,
      });
      return orderDetail(tx, principal, order);
    });
    return { status: 201, body: detail };
  },
});

export const convertQuoteRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/quotes/:quoteId/convert',
  operationId: 'convertQuote',
  summary: 'Make a sales order from an accepted quote',
  description:
    'Once: the order carries the quote’s customer, site, contact, title, currency and lines as a draft, and the quote becomes `converted` pointing at it. Refused for a quote that is not accepted (409 `quote_not_accepted`) or already converted (409 `quote_converted`, with the order’s id).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: z.object({ quoteId: z.uuid() }),
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().min(1) }),
  responses: {
    201: { description: 'The new sales order.', schema: salesOrderDetailSchema },
    404: { description: 'No such quote.' },
    409: {
      description:
        'Not accepted (`quote_not_accepted`), already converted (`quote_converted`) or changed elsewhere (`version_conflict`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const quote = await tx.salesQuotes.lockQuote(params.quoteId);
      if (quote === undefined) {
        throw notFound('This quote does not exist.');
      }
      if (quote.status === 'converted') {
        throw conflict(
          'quote_converted',
          `This quote has already become sales order ${quote.convertedOrderId ?? ''}.`,
        );
      }
      if (quote.status !== 'accepted') {
        throw conflict('quote_not_accepted', 'Only an accepted quote becomes a sales order.');
      }
      if (quote.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const lines = await tx.salesQuotes.quoteLines(quote.id);
      const order = await tx.salesOrders.createOrder(
        {
          customerId: quote.customerId,
          siteId: quote.siteId,
          contactId: quote.contactId,
          quoteId: quote.id,
          title: quote.title,
          currencyCode: quote.currencyCode,
          notes: quote.terms,
          internalNotes: quote.internalNotes,
        },
        lines,
        principal.userId,
      );
      await tx.salesQuotes.markConverted(quote.id, order.id);
      await audit(tx, context, 'quote.converted', 'quote', quote.id, {
        reference: formatQuoteReference(quote.reference, quote.revision),
        orderId: order.id,
      });
      await audit(tx, context, 'sales_order.created', 'sales_order', order.id, {
        reference: formatSalesOrderReference(order.reference),
        quoteId: quote.id,
        lines: lines.length,
      });
      return orderDetail(tx, principal, order);
    });
    return { status: 201, body: detail };
  },
});

export const getSalesOrderRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/orders/:orderId',
  operationId: 'getSalesOrder',
  summary: 'A sales order, with its lines, reservations and jobs',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The sales order.', schema: salesOrderDetailSchema },
    404: { description: 'No such sales order.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const order = await tx.salesOrders.findOrder(params.orderId);
      if (order === undefined) {
        throw notFound('This sales order does not exist.');
      }
      return orderDetail(tx, context.principal, order);
    });
    return { status: 200, body };
  },
});

export const updateSalesOrderRoute = defineRoute({
  method: 'patch',
  path: '/v1/sales/orders/:orderId',
  operationId: 'updateSalesOrder',
  summary: 'Change a draft sales order',
  description:
    'Any of the fields, and the whole set of lines when `lines` is given. Only a draft changes (409 `order_not_draft`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    customerId: orderFields.customerId.optional(),
    siteId: orderFields.siteId,
    contactId: orderFields.contactId,
    title: orderFields.title.optional(),
    notes: orderFields.notes,
    internalNotes: orderFields.internalNotes,
    lines: z.array(lineInputSchema).max(200).optional(),
  }),
  responses: {
    200: { description: 'The sales order.', schema: salesOrderDetailSchema },
    404: { description: 'No such sales order, customer or item.' },
    409: {
      description: 'Not a draft (`order_not_draft`) or changed elsewhere (`version_conflict`).',
    },
    422: { description: 'The site or contact is not the customer’s.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await requireOrder(tx, params.orderId);
      const customerId = body.customerId ?? current.customerId;
      await requireCustomerParties(tx, {
        customerId,
        siteId: body.siteId,
        contactId: body.contactId,
      });
      const lines = body.lines === undefined ? undefined : await documentLineInputs(tx, body.lines);
      const result = await tx.salesOrders.updateDraft(
        current.id,
        body.expectedVersion,
        {
          ...(body.customerId === undefined ? {} : { customerId }),
          ...(body.siteId === undefined ? {} : { siteId: body.siteId }),
          ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          ...(body.internalNotes === undefined ? {} : { internalNotes: body.internalNotes }),
        },
        lines,
      );
      if (typeof result === 'string') {
        orderRefusal(result);
      }
      await audit(tx, context, 'sales_order.updated', 'sales_order', result.id, {
        reference: formatSalesOrderReference(result.reference),
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
      });
      return orderDetail(tx, principal, result);
    });
    return { status: 200, body: detail };
  },
});

export const confirmSalesOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/orders/:orderId/confirm',
  operationId: 'confirmSalesOrder',
  summary: 'Confirm a sales order, reserving its stock',
  description:
    'Owners and admins. Freezes the customer and lines and reserves each stock line at `reserveLocationId` — what the location holds is held for the order, the rest is flagged to order (ADR-0006). A location is required when any line is a stock item (422 `location_required`); an empty order cannot be confirmed (422 `order_empty`); only a draft confirms (409 `order_not_draft`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.issue',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    reserveLocationId: z.uuid().nullable().optional(),
  }),
  responses: {
    200: {
      description: 'The confirmed order, with what each line holds.',
      schema: salesOrderDetailSchema,
    },
    404: { description: 'No such sales order or location.' },
    409: {
      description: 'Not a draft (`order_not_draft`) or changed elsewhere (`version_conflict`).',
    },
    422: {
      description:
        'Nothing to confirm (`order_empty`), or stock lines without a location (`location_required`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (order.status !== 'draft') {
        throw conflict('order_not_draft', 'Only a draft is confirmed.');
      }
      if (order.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const lines = await tx.salesOrders.orderLines(order.id);
      if (lines.length === 0) {
        throw unprocessable('order_empty', 'Add at least one line before confirming.');
      }
      const stock = await hasStockLines(tx, lines);
      const locationId = body.reserveLocationId ?? null;
      if (stock && locationId === null) {
        throw unprocessable('location_required', 'Say where the stock is reserved.', [
          {
            field: 'body.reserveLocationId',
            code: 'location_required',
            message: 'Choose the location to hold the stock at.',
          },
        ]);
      }
      const customer = (await tx.customers.find(order.customerId))!;
      const confirmed = await tx.salesOrders.confirm(order.id, order.version, {
        confirmedBy: principal.userId,
        customerName: customer.name,
        customerAddress: customer.address,
        reserveLocationId: locationId,
      });
      if (typeof confirmed === 'string') {
        orderRefusal(confirmed);
      }
      await audit(tx, context, 'sales_order.confirmed', 'sales_order', confirmed.id, {
        reference: formatSalesOrderReference(confirmed.reference),
        lines: lines.length,
      });
      if (stock && locationId !== null) {
        await reserveAt(tx, context, confirmed, locationId, 'sales_order.reserved');
      }
      return orderDetail(tx, principal, (await tx.salesOrders.findOrder(confirmed.id))!);
    });
    return { status: 200, body: detail };
  },
});

export const reserveSalesOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/orders/:orderId/reserve',
  operationId: 'reserveSalesOrder',
  summary: 'Re-run an open order’s reservation',
  description:
    'After goods arrived, or to hold the stock at another location: every stock line is released and reserved again at `reserveLocationId` (the order’s own when omitted). Only an open order (409 `order_not_open`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    reserveLocationId: z.uuid().optional(),
  }),
  responses: {
    200: {
      description: 'The order, with what each line now holds.',
      schema: salesOrderDetailSchema,
    },
    404: { description: 'No such sales order or location.' },
    409: { description: 'Not open (`order_not_open`) or changed elsewhere (`version_conflict`).' },
    422: { description: 'No location to reserve at (`location_required`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (!salesOrderOpen(order.status)) {
        throw conflict('order_not_open', 'Only a confirmed order holds stock.');
      }
      if (order.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const locationId = body.reserveLocationId ?? order.reserveLocationId;
      if (locationId === null) {
        throw unprocessable('location_required', 'Say where the stock is reserved.', [
          {
            field: 'body.reserveLocationId',
            code: 'location_required',
            message: 'Choose the location to hold the stock at.',
          },
        ]);
      }
      await reserveAt(tx, context, order, locationId, 'sales_order.reserved');
      return orderDetail(tx, principal, (await tx.salesOrders.findOrder(order.id))!);
    });
    return { status: 200, body: detail };
  },
});

export const cancelSalesOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/orders/:orderId/cancel',
  operationId: 'cancelSalesOrder',
  summary: 'Cancel a sales order',
  description:
    'A draft is cancelled by whoever manages sales; a confirmed order by an owner or admin, which releases everything it held. A fulfilled or cancelled order is closed (409 `order_closed`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().max(1000).optional(),
  }),
  responses: {
    200: { description: 'The cancelled order.', schema: salesOrderDetailSchema },
    403: { description: 'Only an owner or admin cancels a confirmed order.' },
    404: { description: 'No such sales order.' },
    409: { description: 'Closed (`order_closed`) or changed elsewhere (`version_conflict`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (order.status === 'fulfilled' || order.status === 'cancelled') {
        throw conflict('order_closed', 'This order is closed.');
      }
      if (order.status !== 'draft' && !holds(principal, 'sales.issue')) {
        throw forbidden('Only an owner or admin cancels a confirmed order.');
      }
      const cancelled = await tx.salesOrders.cancel(
        order.id,
        body.expectedVersion,
        principal.userId,
        body.reason ?? null,
      );
      if (typeof cancelled === 'string') {
        orderRefusal(cancelled);
      }
      await audit(tx, context, 'sales_order.cancelled', 'sales_order', cancelled.id, {
        reference: formatSalesOrderReference(cancelled.reference),
        reason: body.reason ?? null,
        wasOpen: order.status !== 'draft',
      });
      return orderDetail(tx, principal, cancelled);
    });
    return { status: 200, body: detail };
  },
});

const jobForOrderSchema = workOrderInputSchema.omit({ customerId: true, siteId: true }).extend({
  /** Defaults to the order's site. */
  siteId: z.uuid().optional(),
});

export const linkSalesOrderJobRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/orders/:orderId/work-orders',
  operationId: 'linkSalesOrderWorkOrder',
  summary: 'Link a job to the order, or create one for it',
  description:
    'Nothing links on its own: a dispatcher names an existing job of the same customer (`workOrderId`) or describes a new one (`create`, made the way `POST /v1/work-orders` makes it, needing `work_order.manage`). Not for a cancelled or fulfilled order (409 `order_closed`). Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  idempotent: true,
  params: orderParams,
  query: noSchema,
  body: z.union([z.object({ workOrderId: z.uuid() }), z.object({ create: jobForOrderSchema })]),
  responses: {
    200: { description: 'The order with its jobs.', schema: salesOrderDetailSchema },
    403: { description: 'Creating a job needs `work_order.manage`.' },
    404: { description: 'No such sales order or job.' },
    409: { description: 'The order is closed (`order_closed`); or what creating a job refuses.' },
    422: {
      description:
        'The job is another customer’s (`work_order_not_customers`); the new job has no site (`site_required`); or what creating a job refuses.',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (order.status === 'cancelled' || order.status === 'fulfilled') {
        throw conflict('order_closed', 'This order is closed; it takes no more jobs.');
      }
      let workOrderId: string;
      if ('workOrderId' in body) {
        const job = await tx.workOrders.find(body.workOrderId);
        if (job === undefined) {
          throw notFound('This work order does not exist.');
        }
        if (job.customerId !== order.customerId) {
          throw unprocessable('work_order_not_customers', 'The job must be the same customer’s.', [
            {
              field: 'body.workOrderId',
              code: 'work_order_not_customers',
              message: 'Choose one of the customer’s jobs.',
            },
          ]);
        }
        workOrderId = job.id;
      } else {
        if (!holds(principal, 'work_order.manage')) {
          throw forbidden('Only the office creates jobs.');
        }
        const siteId = body.create.siteId ?? order.siteId;
        if (siteId === null) {
          throw unprocessable('site_required', 'The job needs a site.', [
            { field: 'body.create.siteId', code: 'site_required', message: 'Choose a site.' },
          ]);
        }
        const job = await createWorkOrder(tx, context, {
          ...body.create,
          customerId: order.customerId,
          siteId,
          ...(body.create.title === undefined ? { title: order.title } : {}),
        });
        workOrderId = job.id;
      }
      await tx.salesOrders.linkWorkOrder(order.id, workOrderId, principal.userId);
      await audit(tx, context, 'sales_order.job_linked', 'sales_order', order.id, {
        reference: formatSalesOrderReference(order.reference),
        workOrderId,
        created: !('workOrderId' in body),
      });
      return orderDetail(tx, principal, order);
    });
    return { status: 200, body: detail };
  },
});

export const unlinkSalesOrderJobRoute = defineRoute({
  method: 'delete',
  path: '/v1/sales/orders/:orderId/work-orders/:workOrderId',
  operationId: 'unlinkSalesOrderWorkOrder',
  summary: 'Unlink a job from the order',
  description: 'The job itself is untouched; what it already delivered stays delivered.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  params: orderParams.extend({ workOrderId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The order with its remaining jobs.', schema: salesOrderDetailSchema },
    404: { description: 'No such sales order, or the job is not linked to it.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (!(await tx.salesOrders.unlinkWorkOrder(order.id, params.workOrderId))) {
        throw notFound('This job is not linked to the order.');
      }
      await audit(tx, context, 'sales_order.job_unlinked', 'sales_order', order.id, {
        reference: formatSalesOrderReference(order.reference),
        workOrderId: params.workOrderId,
      });
      return orderDetail(tx, principal, order);
    });
    return { status: 200, body: detail };
  },
});

export const toOrderRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/to-order',
  operationId: 'listStockToOrder',
  summary: 'Stock that confirmed orders need and no location could hold for them',
  description:
    'Every stock line of an open order with a shortfall (ADR-0006): what to buy, most recent order first.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
  body: noSchema,
  responses: {
    200: {
      description: 'Short lines.',
      schema: z.object({
        items: z.array(
          z.object({
            order: z.object({ id: z.uuid(), reference: z.string(), title: z.string() }),
            lineId: z.uuid(),
            item: itemSummarySchema,
            description: z.string(),
            location: z.object({ id: z.uuid(), name: z.string() }).nullable(),
            shortfall: z.string(),
          }),
        ),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const short = await tx.salesOrders.shortLines(query.limit);
      const [found, places] = await Promise.all([
        tx.inventoryCatalogue.findItems(short.map((line) => line.itemId)),
        tx.inventoryStock.findLocations(
          short.flatMap((line) => (line.locationId === null ? [] : [line.locationId])),
        ),
      ]);
      const item = new Map(found.map((row) => [row.id, row]));
      const place = new Map(places.map((row) => [row.id, row]));
      return short.flatMap((line) => {
        const i = item.get(line.itemId);
        const where = line.locationId === null ? undefined : place.get(line.locationId);
        return i === undefined
          ? []
          : [
              {
                order: {
                  id: line.orderId,
                  reference: formatSalesOrderReference(line.reference),
                  title: line.title,
                },
                lineId: line.lineId,
                item: itemSummary(i),
                description: line.description,
                location: where === undefined ? null : { id: where.id, name: where.name },
                shortfall: line.shortfall,
              },
            ];
      });
    });
    return { status: 200, body: { items } };
  },
});

export const salesOrderRoutes = [
  listSalesOrdersRoute,
  createSalesOrderRoute,
  convertQuoteRoute,
  getSalesOrderRoute,
  updateSalesOrderRoute,
  confirmSalesOrderRoute,
  reserveSalesOrderRoute,
  cancelSalesOrderRoute,
  linkSalesOrderJobRoute,
  unlinkSalesOrderJobRoute,
  toOrderRoute,
];
