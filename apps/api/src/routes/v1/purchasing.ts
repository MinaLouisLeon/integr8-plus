import {
  compareDecimals,
  currencyCodeSchema,
  holds,
  type Principal,
  PURCHASE_ORDER_STATUSES,
  purchaseOrderReceivable,
  purchaseOrderStatusSchema,
  positiveQuantitySchema,
  SUPPLIER_STATUSES,
  supplierStatusSchema,
  taxRateSchema,
  decimalAmountSchema,
} from '@integr8/core';
import {
  addDecimals,
  type GoodsReceipt,
  type MovementInput,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Supplier,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  crmAudit as audit,
  decodeDateCursor,
  encodeDateCursor,
  versionConflict,
} from './crm-shared.js';
import { requireLocation, stockRefusal } from './inventory-stock.js';
import { byLot, lotSpecsSchema, lotsArriving, lotsLeaving } from './stock-lots.js';
import { itemSummary, itemSummarySchema, seesCosts } from './inventory.js';
import { companyName } from './finance-invoices.js';
import { stripUndefined } from './customers.js';
import { companyToday } from './sales-quotes.js';
import {
  addressInputSchema,
  addressSchema,
  decodeNameCursor,
  encodeNameCursor,
  many,
} from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Suppliers, purchase orders and goods receipts (CRM/ERP plan, phase E2).
 *
 * Every route needs the company's `purchasing` module as well as the seat's
 * permission. A dispatcher drafts an order; an owner or admin approves it
 * (`purchasing.approve`); goods are received against an approved order, and
 * each receipt line that is a stock item is written to the ledger (ADR-0003)
 * at the price received, which folds into the item's average cost. Returns to
 * the supplier reverse what a receipt put in.
 *
 * Prices are decimal strings in the company currency; tax is an optional
 * rate per line in basis points (2000 = 20%), a record for the company's
 * books, not a tax engine.
 *
 * Only the company currency. A receipt folds its price straight into the
 * item's average cost and the ledger, both of which are in the company
 * currency and convert nothing, so an order in dollars would have turned 100
 * dollars into 100 pounds of stock. An order still accepts `currencyCode`, as
 * it always has, as long as it names the company's own.
 */

export const TAGS = ['purchasing'];
export const FEATURE = 'purchasing' as const;

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const supplierSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: supplierStatusSchema,
});

export const supplierSchema = supplierSummarySchema.extend({
  contactName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  taxReference: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  leadTimeDays: z.number().int().nullable(),
  address: addressSchema,
  notes: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export function supplierSummary(supplier: Supplier): z.infer<typeof supplierSummarySchema> {
  return { id: supplier.id, name: supplier.name, status: supplier.status };
}

export function supplierBody(supplier: Supplier): z.infer<typeof supplierSchema> {
  return {
    ...supplierSummary(supplier),
    contactName: supplier.contactName,
    email: supplier.email,
    phone: supplier.phone,
    taxReference: supplier.taxReference,
    paymentTerms: supplier.paymentTerms,
    leadTimeDays: supplier.leadTimeDays,
    address: supplier.address,
    notes: supplier.notes,
    version: supplier.version,
    createdAt: iso(supplier.createdAt),
    updatedAt: iso(supplier.updatedAt),
  };
}

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const supplierFields = {
  name: z.string().trim().min(1).max(200),
  contactName: optionalText(200),
  email: z.email().trim().max(320).nullable().optional(),
  phone: optionalText(40),
  taxReference: optionalText(64),
  paymentTerms: optionalText(200),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  address: addressInputSchema.optional(),
  status: supplierStatusSchema.optional(),
  notes: z.string().max(10_000).nullable().optional(),
};

/** What the request carries, without what it left out. */
function supplierInput(body: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    Object.keys(supplierFields).flatMap((key) =>
      body[key] === undefined
        ? []
        : [
            [
              key,
              key === 'address' ? stripUndefined(body[key] as Record<string, unknown>) : body[key],
            ],
          ],
    ),
  );
}

/** Unique-index violations, said in words. */
function uniqueRefusal(error: unknown): never {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === '23505' && constraint === 'erp_suppliers_name_unique') {
    throw new ApiError(409, 'supplier_name_taken', 'There is already a supplier with this name.', [
      {
        field: 'body.name',
        code: 'supplier_name_taken',
        message: 'There is already a supplier with this name.',
      },
    ]);
  }
  throw error;
}

/** A supplier of this company that may still be ordered from. */
async function requireActiveSupplier(tx: TenantTransaction, supplierId: string): Promise<Supplier> {
  const supplier = await tx.inventoryPurchasing.findSupplier(supplierId);
  if (supplier === undefined) {
    throw new ApiError(404, 'supplier_not_found', 'This supplier does not exist.', [
      {
        field: 'body.supplierId',
        code: 'supplier_not_found',
        message: 'This supplier does not exist.',
      },
    ]);
  }
  if (supplier.status !== 'active') {
    throw unprocessable('supplier_inactive', 'This supplier is inactive. Reactivate it first.', [
      {
        field: 'body.supplierId',
        code: 'supplier_inactive',
        message: 'This supplier is inactive.',
      },
    ]);
  }
  return supplier;
}

export const listSuppliersRoute = defineRoute({
  method: 'get',
  path: '/v1/purchasing/suppliers',
  operationId: 'listSuppliers',
  summary: 'Find suppliers',
  description:
    'Alphabetical, a page at a time. `q` matches words or their beginnings in the name, contact, email or tax reference. Active suppliers only unless `status` says otherwise.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(supplierStatusSchema, SUPPLIER_STATUSES.length),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of suppliers.',
      schema: z.object({ items: z.array(supplierSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeNameCursor(query.cursor);
    const page = await withTenant(context.principal.tenantId, (tx) =>
      tx.inventoryPurchasing.listSuppliers({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status.length === 0 ? ['active'] : query.status,
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      }),
    );
    return {
      status: 200,
      body: { items: page.items.map(supplierBody), nextCursor: encodeNameCursor(page.next) },
    };
  },
});

export const createSupplierRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/suppliers',
  operationId: 'createSupplier',
  summary: 'Add a supplier',
  description: 'Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object(supplierFields),
  responses: {
    201: { description: 'The supplier.', schema: supplierSchema },
    409: { description: 'The name is taken (`supplier_name_taken`).' },
  },
  handler: async ({ body }, context) => {
    const supplier = await withTenant(context.principal.tenantId, async (tx) => {
      const created = await tx.inventoryPurchasing
        .createSupplier({ ...supplierInput(body), name: body.name }, context.principal.userId)
        .catch(uniqueRefusal);
      await audit(tx, context, 'supplier.created', 'supplier', created.id, {
        name: created.name,
      });
      return created;
    });
    return { status: 201, body: supplierBody(supplier) };
  },
});

const supplierParams = z.object({ supplierId: z.uuid() });

export const updateSupplierRoute = defineRoute({
  method: 'patch',
  path: '/v1/purchasing/suppliers/:supplierId',
  operationId: 'updateSupplier',
  summary: 'Change a supplier',
  description:
    'Send `expectedVersion` as read. Setting `status` to `inactive` keeps the supplier on record but stops new orders to it.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  params: supplierParams,
  query: noSchema,
  body: z
    .object({
      ...supplierFields,
      name: supplierFields.name.optional(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  responses: {
    200: { description: 'The supplier as it is now.', schema: supplierSchema },
    404: { description: 'No such supplier.' },
    409: { description: 'Changed by somebody else (`version_conflict`) or the name is taken.' },
  },
  handler: async ({ params, body }, context) => {
    const supplier = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.inventoryPurchasing
        .updateSupplier(params.supplierId, body.expectedVersion, supplierInput(body))
        .catch(uniqueRefusal);
      if (result === 'not_found') {
        throw notFound('This supplier does not exist.');
      }
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      await audit(tx, context, 'supplier.updated', 'supplier', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
        version: result.version,
      });
      return result;
    });
    return { status: 200, body: supplierBody(supplier) };
  },
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/** Seats that manage purchasing or move stock see prices and costs. */
export const seesPrices = (principal: Principal) =>
  holds(principal, 'purchasing.manage') || seesCosts(principal);

const totalsSchema = z.object({ subtotal: z.string(), tax: z.string(), total: z.string() });

export const orderSummarySchema = z.object({
  id: z.uuid(),
  /** `PO-000123`. */
  reference: z.string(),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  status: purchaseOrderStatusSchema,
  currencyCode: z.string(),
  expectedDate: z.iso.date().nullable(),
  /** Null to seats that may not see prices. */
  totals: totalsSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const orderSchema = orderSummarySchema.extend({
  deliveryLocation: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  notes: z.string().nullable(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  cancelledBy: z.uuid().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  createdBy: z.uuid(),
});

export const orderLineSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  item: itemSummarySchema,
  description: z.string(),
  quantityOrdered: z.string(),
  quantityReceived: z.string(),
  /** Null to seats that may not see prices. */
  unitPrice: z.string().nullable(),
  taxRateBp: z.number().int(),
  subtotal: z.string().nullable(),
  tax: z.string().nullable(),
});

export const receiptSchema = z.object({
  id: z.uuid(),
  location: z.object({ id: z.uuid(), name: z.string() }),
  supplierNote: z.string().nullable(),
  notes: z.string().nullable(),
  receivedBy: z.uuid(),
  receivedAt: z.iso.datetime(),
  lines: z.array(
    z.object({
      id: z.uuid(),
      orderLineId: z.uuid(),
      quantity: z.string(),
      unitCost: z.string().nullable(),
      returnedQuantity: z.string(),
    }),
  ),
});

export const orderDetailSchema = z.object({
  order: orderSchema,
  lines: z.array(orderLineSchema),
  receipts: z.array(receiptSchema),
  /**
   * Who is buying and from whom, as the printed order names them: the company
   * as its invoices do (legal name, address and tax number from the finance
   * settings, else its name), and the supplier as it is now.
   */
  parties: z.object({
    buyer: z.object({
      name: z.string(),
      address: z.string().nullable(),
      taxReference: z.string().nullable(),
    }),
    supplier: z.object({
      name: z.string(),
      address: addressSchema.nullable(),
      contactName: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      taxReference: z.string().nullable(),
    }),
  }),
  can: z.object({
    edit: z.boolean(),
    approve: z.boolean(),
    cancel: z.boolean(),
    receive: z.boolean(),
  }),
});

export const formatReference = (reference: number) => `PO-${String(reference).padStart(6, '0')}`;

async function orderSummaries(
  tx: TenantTransaction,
  orders: readonly PurchaseOrder[],
  prices: boolean,
): Promise<z.infer<typeof orderSummarySchema>[]> {
  const totals = prices
    ? await Promise.all(orders.map((order) => tx.inventoryPurchasing.orderTotals(order.id)))
    : [];
  return orders.map((order, index) => ({
    id: order.id,
    reference: formatReference(order.reference),
    supplier: { id: order.supplierId, name: order.supplierName },
    status: order.status,
    currencyCode: order.currencyCode,
    expectedDate: order.expectedDate,
    totals: prices ? totals[index]! : null,
    createdAt: iso(order.createdAt),
    updatedAt: iso(order.updatedAt),
  }));
}

async function orderBody(
  tx: TenantTransaction,
  order: PurchaseOrder,
  prices: boolean,
): Promise<z.infer<typeof orderSchema>> {
  const [summary] = await orderSummaries(tx, [order], prices);
  const location =
    order.deliveryLocationId === null
      ? undefined
      : await tx.inventoryStock.findLocation(order.deliveryLocationId);
  return {
    ...summary!,
    deliveryLocation: location === undefined ? null : { id: location.id, name: location.name },
    notes: order.notes,
    approvedBy: order.approvedBy,
    approvedAt: isoOrNull(order.approvedAt),
    cancelledBy: order.cancelledBy,
    cancelledAt: isoOrNull(order.cancelledAt),
    cancelReason: order.cancelReason,
    version: order.version,
    createdBy: order.createdBy,
  };
}

async function lineBodies(
  tx: TenantTransaction,
  lines: readonly PurchaseOrderLine[],
  prices: boolean,
): Promise<z.infer<typeof orderLineSchema>[]> {
  const items = new Map(
    (await tx.inventoryCatalogue.findItems(lines.map((line) => line.itemId))).map((item) => [
      item.id,
      item,
    ]),
  );
  return lines.map((line) => ({
    id: line.id,
    position: line.position,
    item: itemSummary(items.get(line.itemId)!),
    description: line.description,
    quantityOrdered: line.quantityOrdered,
    quantityReceived: line.quantityReceived,
    unitPrice: prices ? line.unitPrice : null,
    taxRateBp: line.taxRateBp,
    subtotal: prices ? line.subtotal : null,
    tax: prices ? line.tax : null,
  }));
}

async function receiptBodies(
  tx: TenantTransaction,
  receipts: readonly GoodsReceipt[],
  prices: boolean,
): Promise<z.infer<typeof receiptSchema>[]> {
  const locations = new Map(
    (await tx.inventoryStock.findLocations(receipts.map((receipt) => receipt.locationId))).map(
      (location) => [location.id, location],
    ),
  );
  return receipts.map((receipt) => {
    const location = locations.get(receipt.locationId)!;
    return {
      id: receipt.id,
      location: { id: location.id, name: location.name },
      supplierNote: receipt.supplierNote,
      notes: receipt.notes,
      receivedBy: receipt.receivedBy,
      receivedAt: iso(receipt.receivedAt),
      lines: receipt.lines.map((line) => ({
        id: line.id,
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        unitCost: prices ? line.unitCost : null,
        returnedQuantity: line.returnedQuantity,
      })),
    };
  });
}

async function orderDetail(
  tx: TenantTransaction,
  context: RequestContext,
  order: PurchaseOrder,
): Promise<z.infer<typeof orderDetailSchema>> {
  const { principal } = context;
  const prices = seesPrices(principal);
  const [body, lines, receipts, supplier, finance] = await Promise.all([
    orderBody(tx, order, prices),
    tx.inventoryPurchasing.orderLines(order.id),
    tx.inventoryPurchasing.receiptsFor(order.id),
    tx.inventoryPurchasing.findSupplier(order.supplierId),
    tx.financeInvoices.settings(),
  ]);
  const manage = holds(principal, 'purchasing.manage');
  return {
    order: body,
    lines: await lineBodies(tx, lines, prices),
    receipts: await receiptBodies(tx, receipts, prices),
    parties: {
      buyer: {
        name: finance.legalName ?? (await companyName(principal.tenantId)),
        address: finance.address,
        taxReference: finance.taxReference,
      },
      supplier: {
        name: supplier?.name ?? order.supplierName,
        address: supplier?.address ?? null,
        contactName: supplier?.contactName ?? null,
        email: supplier?.email ?? null,
        phone: supplier?.phone ?? null,
        taxReference: supplier?.taxReference ?? null,
      },
    },
    can: {
      edit: manage && order.status === 'draft',
      approve: holds(principal, 'purchasing.approve') && order.status === 'draft',
      cancel: manage && order.status !== 'received' && order.status !== 'cancelled',
      receive: manage && purchaseOrderReceivable(order.status),
    },
  };
}

export const supplierDetailSchema = z.object({
  supplier: supplierSchema,
  /** The supplier's most recent orders, newest first. */
  orders: z.array(orderSummarySchema),
  can: z.object({ manage: z.boolean() }),
});

export const getSupplierRoute = defineRoute({
  method: 'get',
  path: '/v1/purchasing/suppliers/:supplierId',
  operationId: 'getSupplier',
  summary: 'Read a supplier',
  description: 'The supplier with its most recent orders and what this seat may do.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.read',
  feature: FEATURE,
  params: supplierParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The supplier.', schema: supplierDetailSchema },
    404: { description: 'No such supplier.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const supplier = await tx.inventoryPurchasing.findSupplier(params.supplierId);
      if (supplier === undefined) {
        throw notFound('This supplier does not exist.');
      }
      const orders = await tx.inventoryPurchasing.listOrders({
        supplierId: supplier.id,
        limit: 20,
      });
      return {
        supplier: supplierBody(supplier),
        orders: await orderSummaries(tx, orders.items, seesPrices(context.principal)),
        can: { manage: holds(context.principal, 'purchasing.manage') },
      };
    });
    return { status: 200, body };
  },
});

const lineInputSchema = z.object({
  itemId: z.uuid(),
  /** Defaults to the item's name as it is now. */
  description: z.string().trim().min(1).max(500).optional(),
  quantityOrdered: positiveQuantitySchema,
  /**
   * In the order's currency. Left out, the supplier's price list gives it: the
   * price in force today for this quantity (ADR-0012).
   */
  unitPrice: decimalAmountSchema.optional(),
  /** Basis points: 2000 is 20%. */
  taxRateBp: taxRateSchema.optional(),
});

const orderFields = {
  supplierId: z.uuid(),
  expectedDate: z.iso.date().nullable().optional(),
  deliveryLocationId: z.uuid().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
};

/**
 * Refuses an order in another currency: see the module comment. 422 rather
 * than a quiet substitution, so a client that sent dollars learns its prices
 * were not taken as pounds.
 */
function currencyNotCompany(currencyCode: string, companyCurrency: string, field: string): never {
  const message = `Purchase orders are in the company currency, ${companyCurrency}. Convert ${currencyCode} prices before you enter them.`;
  throw unprocessable('purchase_currency_not_company', message, [
    { field, code: 'purchase_currency_not_company', message },
  ]);
}

/** Lines as the repository takes them, with each item checked and described. */
async function orderLineInputs(
  tx: TenantTransaction,
  lines: readonly z.infer<typeof lineInputSchema>[],
  pricing: { supplierId: string; currencyCode: string },
) {
  const today = await companyToday(tx);
  const items = new Map(
    (await tx.inventoryCatalogue.findItems(lines.map((line) => line.itemId))).map((item) => [
      item.id,
      item,
    ]),
  );
  const inputs = [];
  for (const [index, line] of lines.entries()) {
    const item = items.get(line.itemId);
    if (item?.archivedAt !== null) {
      throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
        {
          field: `body.lines.${index}.itemId`,
          code: 'item_not_found',
          message: item === undefined ? 'This item does not exist.' : 'This item is archived.',
        },
      ]);
    }
    const unitPrice =
      line.unitPrice ??
      (
        await tx.supplierPrices.priceFor({
          ...pricing,
          itemId: item.id,
          quantity: line.quantityOrdered,
          on: today,
        })
      )?.unitPrice;
    if (unitPrice === undefined) {
      throw unprocessable(
        'price_required',
        'This supplier has no price for this item. Enter one.',
        [
          {
            field: `body.lines.${index}.unitPrice`,
            code: 'price_required',
            message: 'Enter the price.',
          },
        ],
      );
    }
    inputs.push({
      itemId: item.id,
      description: line.description ?? item.name,
      quantityOrdered: line.quantityOrdered,
      unitPrice,
      ...(line.taxRateBp === undefined ? {} : { taxRateBp: line.taxRateBp }),
    });
  }
  return inputs;
}

const orderParams = z.object({ orderId: z.uuid() });

async function requireOrder(tx: TenantTransaction, orderId: string): Promise<PurchaseOrder> {
  const order = await tx.inventoryPurchasing.lockOrder(orderId);
  if (order === undefined) {
    throw notFound('This purchase order does not exist.');
  }
  return order;
}

function orderRefusal(result: 'not_found' | 'version_conflict' | 'not_draft'): never {
  if (result === 'not_found') {
    throw notFound('This purchase order does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('order_not_draft', 'Only a draft changes. This order has been approved.');
}

export const listOrdersRoute = defineRoute({
  method: 'get',
  path: '/v1/purchasing/orders',
  operationId: 'listPurchaseOrders',
  summary: 'Find purchase orders',
  description:
    'Newest first, a page at a time. `q` matches the reference (`PO-000123`, `123`) or words of the supplier name.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(purchaseOrderStatusSchema, PURCHASE_ORDER_STATUSES.length),
    supplierId: z.uuid().optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of orders.',
      schema: z.object({ items: z.array(orderSummarySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.inventoryPurchasing.listOrders({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        ...(query.supplierId === undefined ? {} : { supplierId: query.supplierId }),
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await orderSummaries(tx, page.items, seesPrices(context.principal)),
        nextCursor: encodeDateCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const createOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/orders',
  operationId: 'createPurchaseOrder',
  summary: 'Draft a purchase order',
  description:
    'A draft in the company currency, numbered `PO-000001` onwards. `currencyCode`, when sent, must be the company currency. Lines name catalogue items; a line without a `description` takes the item name. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    ...orderFields,
    /** The company currency, which is also the default; any other is refused. */
    currencyCode: currencyCodeSchema.optional(),
    lines: z.array(lineInputSchema).max(200).default([]),
  }),
  responses: {
    201: { description: 'The order.', schema: orderDetailSchema },
    404: {
      description:
        'No such supplier (`supplier_not_found`), item (`item_not_found`) or location (`location_not_found`).',
    },
    422: {
      description:
        'Invalid, the supplier is inactive (`supplier_inactive`), or `currencyCode` is not the company currency (`purchase_currency_not_company`).',
    },
  },
  handler: async ({ body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const supplier = await requireActiveSupplier(tx, body.supplierId);
      if (typeof body.deliveryLocationId === 'string') {
        await requireLocation(tx, body.deliveryLocationId, 'body.deliveryLocationId');
      }
      const currencyCode = (await tx.settings.get()).currency;
      if (body.currencyCode !== undefined && body.currencyCode !== currencyCode) {
        currencyNotCompany(body.currencyCode, currencyCode, 'body.currencyCode');
      }
      const lines = await orderLineInputs(tx, body.lines, {
        supplierId: supplier.id,
        currencyCode,
      });
      const order = await tx.inventoryPurchasing.createOrder(
        {
          supplierId: supplier.id,
          supplierName: supplier.name,
          currencyCode,
          expectedDate: body.expectedDate ?? null,
          deliveryLocationId: body.deliveryLocationId ?? null,
          notes: body.notes ?? null,
        },
        lines,
        context.principal.userId,
      );
      await audit(tx, context, 'purchase_order.created', 'purchase_order', order.id, {
        reference: formatReference(order.reference),
        supplierId: supplier.id,
        lines: lines.length,
      });
      return orderDetail(tx, context, order);
    });
    return { status: 201, body: detail };
  },
});

export const getOrderRoute = defineRoute({
  method: 'get',
  path: '/v1/purchasing/orders/:orderId',
  operationId: 'getPurchaseOrder',
  summary: 'Read a purchase order',
  description: 'The order, its lines, every receipt against it and what this seat may do.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.read',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The order.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
  },
  handler: async ({ params }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const order = await tx.inventoryPurchasing.findOrder(params.orderId);
      if (order === undefined) {
        throw notFound('This purchase order does not exist.');
      }
      return orderDetail(tx, context, order);
    });
    return { status: 200, body: detail };
  },
});

export const updateOrderRoute = defineRoute({
  method: 'patch',
  path: '/v1/purchasing/orders/:orderId',
  operationId: 'updatePurchaseOrder',
  summary: 'Change a draft purchase order',
  description:
    'Send `expectedVersion` as read. `lines`, when sent, replaces every line. Only a draft changes (409 `order_not_draft`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z
    .object({
      ...orderFields,
      supplierId: orderFields.supplierId.optional(),
      lines: z.array(lineInputSchema).max(200).optional(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  responses: {
    200: { description: 'The order as it is now.', schema: orderDetailSchema },
    404: { description: 'No such order, supplier, item or location.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`) or no longer a draft (`order_not_draft`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const supplier =
        body.supplierId === undefined
          ? undefined
          : await requireActiveSupplier(tx, body.supplierId);
      if (typeof body.deliveryLocationId === 'string') {
        await requireLocation(tx, body.deliveryLocationId, 'body.deliveryLocationId');
      }
      let lines;
      if (body.lines !== undefined) {
        const current = await tx.inventoryPurchasing.findOrder(params.orderId);
        if (current === undefined) {
          throw notFound('This purchase order does not exist.');
        }
        lines = await orderLineInputs(tx, body.lines, {
          supplierId: supplier?.id ?? current.supplierId,
          currencyCode: current.currencyCode,
        });
      }
      const result = await tx.inventoryPurchasing.updateDraft(
        params.orderId,
        body.expectedVersion,
        {
          ...(supplier === undefined
            ? {}
            : { supplierId: supplier.id, supplierName: supplier.name }),
          ...(body.expectedDate === undefined ? {} : { expectedDate: body.expectedDate }),
          ...(body.deliveryLocationId === undefined
            ? {}
            : { deliveryLocationId: body.deliveryLocationId }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
        },
        lines,
      );
      if (typeof result === 'string') {
        orderRefusal(result);
      }
      await audit(tx, context, 'purchase_order.updated', 'purchase_order', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
        version: result.version,
      });
      return orderDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

const versionBody = z.object({ expectedVersion: z.number().int().positive() });

export const approveOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/orders/:orderId/approve',
  operationId: 'approvePurchaseOrder',
  summary: 'Approve a purchase order',
  description:
    'Owners and admins approve. From then on the lines are fixed and goods may be received against it. A draft with no lines cannot be approved (422 `order_empty`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.approve',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: { description: 'The order, approved.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`) or not a draft (`order_not_draft`).',
    },
    422: { description: 'No lines (`order_empty`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (order.status !== 'draft') {
        orderRefusal('not_draft');
      }
      if ((await tx.inventoryPurchasing.orderLines(order.id)).length === 0) {
        throw unprocessable('order_empty', 'Add at least one line before approving.');
      }
      const result = await tx.inventoryPurchasing.setStatus(order.id, body.expectedVersion, {
        status: 'approved',
        actorId: context.principal.userId,
      });
      if (typeof result === 'string') {
        orderRefusal(result);
      }
      await audit(tx, context, 'purchase_order.approved', 'purchase_order', result.id, {
        reference: formatReference(result.reference),
      });
      return orderDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

export const cancelOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/orders/:orderId/cancel',
  operationId: 'cancelPurchaseOrder',
  summary: 'Cancel a purchase order',
  description:
    'Closes an order that will not be (fully) delivered. What was already received stays in stock. A received or cancelled order does not change (409 `order_closed`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: versionBody.extend({ reason: z.string().trim().max(1000).nullable().optional() }),
  responses: {
    200: { description: 'The order, cancelled.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
    409: {
      description: 'Changed by somebody else (`version_conflict`) or closed (`order_closed`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (order.status === 'received' || order.status === 'cancelled') {
        throw conflict('order_closed', 'This order is already closed.');
      }
      const result = await tx.inventoryPurchasing.setStatus(order.id, body.expectedVersion, {
        status: 'cancelled',
        actorId: context.principal.userId,
        reason: body.reason ?? null,
      });
      if (typeof result === 'string') {
        orderRefusal(result);
      }
      await audit(tx, context, 'purchase_order.cancelled', 'purchase_order', result.id, {
        reference: formatReference(result.reference),
        reason: body.reason ?? null,
      });
      return orderDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Goods receipts and returns
// ---------------------------------------------------------------------------

/** After a receipt or return, the order's status says how much has arrived. */
async function settleStatus(tx: TenantTransaction, order: PurchaseOrder): Promise<PurchaseOrder> {
  const state = await tx.inventoryPurchasing.receivedState(order.id);
  const status =
    state === 'full' ? 'received' : state === 'partial' ? 'partially_received' : 'approved';
  if (status === order.status) {
    return order;
  }
  const result = await tx.inventoryPurchasing.setStatus(order.id, order.version, { status });
  if (typeof result === 'string') {
    orderRefusal(result);
  }
  return result;
}

/** The receipt-line constraints, said in words. */
function receiptRefusal(error: unknown): never {
  const { constraint } = error as { constraint?: string };
  if (constraint === 'erp_purchase_order_lines_received_range') {
    throw unprocessable(
      'over_received',
      'That is more than the order has left to receive. Nothing was recorded.',
    );
  }
  if (constraint === 'erp_goods_receipt_lines_returned_range') {
    throw unprocessable(
      'over_returned',
      'That is more than this receipt line brought in. Nothing was recorded.',
    );
  }
  throw error;
}

export const receiveOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/orders/:orderId/receipts',
  operationId: 'receivePurchaseOrder',
  summary: 'Record goods received against an order',
  description:
    "Each line names an order line and what arrived, at the order's price unless `unitCost` says otherwise. Stock items are written to the ledger at the location given (or the order's delivery location) and the cost folds into the item's average. The order becomes partially or fully received. Needs `Idempotency-Key`.",
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  idempotent: 'required',
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().positive(),
    /** Defaults to the order's delivery location. */
    locationId: z.uuid().optional(),
    supplierNote: z.string().trim().max(200).nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
    lines: z
      .array(
        z.object({
          orderLineId: z.uuid(),
          quantity: positiveQuantitySchema,
          unitCost: decimalAmountSchema.optional(),
          /** For a serial-numbered or batched item: the codes arriving (ADR-0013). */
          lots: lotSpecsSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  responses: {
    201: { description: 'The order after the receipt.', schema: orderDetailSchema },
    404: { description: 'No such order, order line or location.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`), not approved (`order_not_receivable`), or already posted (`already_posted`).',
    },
    422: {
      description:
        'More than is left to receive (`over_received`), no location (`location_required`), a line named twice (`line_repeated`), or an order in another currency than the company’s (`purchase_currency_not_company`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await requireOrder(tx, params.orderId);
      if (order.version !== body.expectedVersion) {
        throw versionConflict();
      }
      if (!purchaseOrderReceivable(order.status)) {
        throw conflict('order_not_receivable', 'Goods are received against an approved order.');
      }
      // An order drafted in another currency before that was refused would
      // still fold its prices into stock as if they were the company's. It is
      // cancelled and drafted again in the company currency instead.
      const companyCurrency = (await tx.settings.get()).currency;
      if (order.currencyCode !== companyCurrency) {
        currencyNotCompany(order.currencyCode, companyCurrency, 'params.orderId');
      }
      const locationId = body.locationId ?? order.deliveryLocationId;
      if (locationId === null) {
        throw unprocessable('location_required', 'Say where the goods were put.', [
          {
            field: 'body.locationId',
            code: 'location_required',
            message: 'Say where the goods were put.',
          },
        ]);
      }
      const location = await requireLocation(tx, locationId);
      if (new Set(body.lines.map((line) => line.orderLineId)).size !== body.lines.length) {
        throw unprocessable('line_repeated', 'Name each order line once.');
      }
      const orderLines = new Map(
        (await tx.inventoryPurchasing.orderLines(order.id)).map((line) => [line.id, line]),
      );
      const lines = body.lines.map((line, index) => {
        const orderLine = orderLines.get(line.orderLineId);
        if (orderLine === undefined) {
          throw new ApiError(404, 'order_line_not_found', 'This order has no such line.', [
            {
              field: `body.lines.${index}.orderLineId`,
              code: 'order_line_not_found',
              message: 'This order has no such line.',
            },
          ]);
        }
        return {
          orderLineId: orderLine.id,
          itemId: orderLine.itemId,
          quantity: line.quantity,
          unitCost: line.unitCost ?? orderLine.unitPrice,
          lots: line.lots,
        };
      });
      const receipt = await tx.inventoryPurchasing
        .recordReceipt(
          {
            orderId: order.id,
            locationId: location.id,
            supplierNote: body.supplierNote ?? null,
            notes: body.notes ?? null,
            receivedBy: principal.userId,
          },
          lines,
        )
        .catch(receiptRefusal);

      // Stock items go into the ledger; services and non-stock items are only
      // recorded as received.
      const items = new Map(
        (await tx.inventoryCatalogue.findItems(lines.map((line) => line.itemId))).map((item) => [
          item.id,
          item,
        ]),
      );
      const movements: MovementInput[] = [];
      for (const [index, line] of lines.entries()) {
        const item = items.get(line.itemId)!;
        if (item.kind !== 'stock_item') {
          continue;
        }
        const allocations = await lotsArriving(tx, item, line.quantity, line.lots, {
          actorId: principal.userId,
          field: `body.lines.${index}.lots`,
        });
        await tx.inventoryStock.applyReceiptCost(item.id, line.quantity, line.unitCost);
        movements.push(
          ...byLot(
            {
              itemId: item.id,
              locationId: location.id,
              kind: 'receipt',
              quantity: line.quantity,
              unitCost: line.unitCost,
              sourceKey: `receipt-line:${receipt.lines[index]!.id}`,
              reason: formatReference(order.reference),
            },
            allocations,
          ),
        );
      }
      const postingId = randomUUID();
      await tx.inventoryStock
        .post(movements, { postingId, actorId: principal.userId })
        .catch(stockRefusal);
      const settled = await settleStatus(tx, order);
      await audit(tx, context, 'purchase_order.received', 'purchase_order', order.id, {
        reference: formatReference(order.reference),
        receiptId: receipt.id,
        postingId,
        locationId: location.id,
        lines: lines.length,
        status: settled.status,
      });
      return orderDetail(tx, context, settled);
    });
    return { status: 201, body: detail };
  },
});

export const returnToSupplierRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/receipts/:receiptId/returns',
  operationId: 'returnToSupplier',
  summary: 'Return goods from a receipt to the supplier',
  description:
    'Takes the quantity back out of the location it was received at, as a reversal of the receipt movement, and frees that much of the order line to be received again. Needs `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  idempotent: 'required',
  params: z.object({ receiptId: z.uuid() }),
  query: noSchema,
  body: z.object({
    reason: z.string().trim().min(1).max(1000),
    lines: z
      .array(
        z.object({
          receiptLineId: z.uuid(),
          quantity: positiveQuantitySchema,
          /** For a tracked item: which go back; by default, those this line brought in. */
          lots: lotSpecsSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  responses: {
    201: { description: 'The order after the return.', schema: orderDetailSchema },
    404: { description: 'No such receipt or receipt line.' },
    409: { description: 'Not enough stock left there (`insufficient_stock`) or already posted.' },
    422: { description: 'More than the line brought in (`over_returned`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const receipt = await tx.inventoryPurchasing.findReceipt(params.receiptId);
      if (receipt === undefined) {
        throw notFound('This receipt does not exist.');
      }
      const order = await requireOrder(tx, receipt.orderId);
      if (new Set(body.lines.map((line) => line.receiptLineId)).size !== body.lines.length) {
        throw unprocessable('line_repeated', 'Name each receipt line once.');
      }
      const key = `return:${context.idempotencyKey ?? randomUUID()}`;
      const movements: MovementInput[] = [];
      for (const [index, line] of body.lines.entries()) {
        const received = receipt.lines.find((candidate) => candidate.id === line.receiptLineId);
        if (received === undefined) {
          throw new ApiError(404, 'receipt_line_not_found', 'This receipt has no such line.', [
            {
              field: `body.lines.${index}.receiptLineId`,
              code: 'receipt_line_not_found',
              message: 'This receipt has no such line.',
            },
          ]);
        }
        await tx.inventoryPurchasing.recordReturn(received.id, line.quantity).catch(receiptRefusal);
        const original = await tx.inventoryStock.findMovementBySourceKey(
          `receipt-line:${received.id}`,
        );
        if (original !== undefined) {
          // Received before the item was tracked: it leaves by its lots now.
          const item = await tx.inventoryCatalogue.findItem(original.itemId);
          const leaving = await lotsLeaving(
            tx,
            item!,
            original.locationId,
            line.quantity,
            line.lots,
            {
              today: await companyToday(tx),
              allowExpired: true,
              reason: body.reason,
              field: `body.lines.${index}.lots`,
            },
          );
          movements.push(
            ...byLot(
              {
                itemId: original.itemId,
                locationId: original.locationId,
                kind: 'return_to_supplier',
                quantity: `-${line.quantity}`,
                unitCost: original.unitCost,
                sourceKey: `${key}:${received.id}`,
                reason: body.reason,
                reversalOf: original.id,
              },
              leaving,
            ),
          );
          continue;
        }
        // Serial numbers and batches (ADR-0013): those named, or else those
        // this line brought in that are still where they arrived.
        const brought = await tx.inventoryLots.movedBySource(`receipt-line:${received.id}:lot:`);
        if (brought.length === 0) {
          continue;
        }
        const first = await tx.inventoryStock.findMovementBySourceKey(
          `receipt-line:${received.id}:lot:${brought[0]!.lotId}`,
        );
        const item = await tx.inventoryCatalogue.findItem(first!.itemId);
        const allocations =
          (line.lots?.length ?? 0) > 0
            ? await lotsLeaving(tx, item!, receipt.locationId, line.quantity, line.lots, {
                today: await companyToday(tx),
                allowExpired: true,
                reason: body.reason,
                field: `body.lines.${index}.lots`,
              })
            : await broughtStillHere(tx, receipt.locationId, brought, line.quantity);
        for (const allocation of allocations) {
          const arrived = await tx.inventoryStock.findMovementBySourceKey(
            `receipt-line:${received.id}:lot:${allocation.lotId}`,
          );
          movements.push(
            ...byLot(
              {
                itemId: first!.itemId,
                locationId: receipt.locationId,
                kind: 'return_to_supplier',
                quantity: `-${allocation.quantity}`,
                unitCost: arrived?.unitCost ?? first!.unitCost,
                sourceKey: `${key}:${received.id}`,
                reason: body.reason,
                reversalOf: arrived?.id ?? null,
              },
              [allocation],
            ),
          );
        }
      }
      const postingId = randomUUID();
      await tx.inventoryStock
        .post(movements, { postingId, actorId: principal.userId })
        .catch(stockRefusal);
      const settled = await settleStatus(tx, order);
      await audit(tx, context, 'purchase_order.returned', 'purchase_order', order.id, {
        reference: formatReference(order.reference),
        receiptId: receipt.id,
        postingId,
        reason: body.reason,
        lines: body.lines.length,
      });
      return orderDetail(tx, context, settled);
    });
    return { status: 201, body: detail };
  },
});

export const purchasingRoutes = [
  listSuppliersRoute,
  createSupplierRoute,
  getSupplierRoute,
  updateSupplierRoute,
  listOrdersRoute,
  createOrderRoute,
  getOrderRoute,
  updateOrderRoute,
  approveOrderRoute,
  cancelOrderRoute,
  receiveOrderRoute,
  returnToSupplierRoute,
];

/**
 * The lots a receipt line brought in that are still where they arrived, in
 * the order they came, for a return that names none.
 */
async function broughtStillHere(
  tx: TenantTransaction,
  locationId: string,
  brought: readonly { lotId: string; quantity: string }[],
  quantity: string,
): Promise<{ lotId: string; quantity: string }[]> {
  const allocations: { lotId: string; quantity: string }[] = [];
  let left = quantity;
  for (const lot of brought) {
    if (compareDecimals(left, '0') <= 0) {
      break;
    }
    const held = await tx.inventoryLots.lockBalance(lot.lotId, locationId);
    const most = compareDecimals(held, lot.quantity) < 0 ? held : lot.quantity;
    if (compareDecimals(most, '0') <= 0) {
      continue;
    }
    const take = compareDecimals(most, left) < 0 ? most : left;
    allocations.push({ lotId: lot.lotId, quantity: take });
    left = addDecimals(left, `-${take}`);
  }
  if (compareDecimals(left, '0') > 0) {
    throw conflict(
      'insufficient_stock',
      'What this line brought in is no longer all there. Name the serial numbers or batches going back.',
    );
  }
  return allocations;
}
