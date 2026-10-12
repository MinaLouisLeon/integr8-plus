import {
  compareDecimals,
  currencyCodeSchema,
  decimalAmountSchema,
  positiveQuantitySchema,
} from '@integr8/core';
import { type SupplierPrice, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { requireLocation } from './inventory-stock.js';
import { itemSummary, itemSummarySchema } from './inventory.js';
import { FEATURE, TAGS, seesPrices } from './purchasing.js';
import { companyToday } from './sales-quotes.js';
import { iso } from './schemas.js';

/**
 * Supplier price lists and reorder drafts (eighth round; ADR-0012). A price
 * is per supplier and item, in the supplier's currency, between two days,
 * from a quantity on. A location's reorder list shows what is below its
 * level, net of what is on order, and chosen lines become one draft purchase
 * order per supplier, approved as usual.
 */

const priceSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  item: itemSummarySchema,
  currencyCode: z.string(),
  minQuantity: z.string(),
  unitPrice: z.string(),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable(),
  updatedAt: z.iso.datetime(),
});

const priceInput = z
  .object({
    currencyCode: currencyCodeSchema,
    /** The least quantity on one order line this price is for. */
    minQuantity: positiveQuantitySchema.default('1'),
    unitPrice: decimalAmountSchema,
    validFrom: z.iso.date(),
    validTo: z.iso.date().nullable().default(null),
  })
  .refine((body) => body.validTo === null || body.validTo >= body.validFrom, {
    message: 'A price ends on or after the day it starts.',
    path: ['validTo'],
  });

async function priceBodies(tx: TenantTransaction, prices: readonly SupplierPrice[]) {
  const items = new Map(
    (await tx.inventoryCatalogue.findItems(prices.map((price) => price.itemId))).map((item) => [
      item.id,
      item,
    ]),
  );
  return prices.flatMap((price) => {
    const item = items.get(price.itemId);
    return item === undefined
      ? []
      : [
          {
            id: price.id,
            supplierId: price.supplierId,
            item: itemSummary(item),
            currencyCode: price.currencyCode,
            minQuantity: price.minQuantity,
            unitPrice: price.unitPrice,
            validFrom: price.validFrom,
            validTo: price.validTo,
            updatedAt: iso(price.updatedAt),
          },
        ];
  });
}

function refuseOverlap(): never {
  throw conflict(
    'price_overlaps',
    'Another price for this supplier, item, currency and quantity covers some of these days.',
  );
}

export const listPricesRoute = defineRoute({
  method: 'get',
  path: '/v1/purchasing/prices',
  operationId: 'listSupplierPrices',
  summary: 'Supplier prices, for a supplier or an item',
  description: 'Every price, current, past and future. For those who see prices.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.read',
  feature: FEATURE,
  params: noSchema,
  query: z
    .object({ supplierId: z.uuid().optional(), itemId: z.uuid().optional() })
    .refine((query) => query.supplierId !== undefined || query.itemId !== undefined, {
      message: 'Name a supplier or an item.',
      path: ['supplierId'],
    }),
  body: noSchema,
  responses: {
    200: { description: 'The prices.', schema: z.object({ items: z.array(priceSchema) }) },
    403: { description: 'This seat does not see prices.' },
  },
  handler: async ({ query }, context) => {
    if (!seesPrices(context.principal)) {
      throw new ApiError(403, 'prices_hidden', 'Prices are for those who manage purchasing.');
    }
    const items = await withTenant(context.principal.tenantId, async (tx) =>
      priceBodies(
        tx,
        await tx.supplierPrices.list({
          ...(query.supplierId === undefined ? {} : { supplierId: query.supplierId }),
          ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
        }),
      ),
    );
    return { status: 200, body: { items } };
  },
});

export const addPriceRoute = defineRoute({
  method: 'post',
  path: '/v1/purchasing/suppliers/:supplierId/prices',
  operationId: 'addSupplierPrice',
  summary: 'Add a price to a supplier’s list',
  description:
    'Two prices for the same supplier, item, currency and break may not cover the same day (409 `price_overlaps`). Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  idempotent: true,
  params: z.object({ supplierId: z.uuid() }),
  query: noSchema,
  body: priceInput.and(z.object({ itemId: z.uuid() })),
  responses: {
    201: { description: 'The price.', schema: priceSchema },
    404: { description: 'No such supplier (`supplier_not_found`) or item (`item_not_found`).' },
    409: { description: 'Another price covers some of these days (`price_overlaps`).' },
  },
  handler: async ({ params, body }, context) => {
    const price = await withTenant(context.principal.tenantId, async (tx) => {
      if ((await tx.inventoryPurchasing.findSupplier(params.supplierId)) === undefined) {
        throw new ApiError(404, 'supplier_not_found', 'This supplier does not exist.');
      }
      const item = await tx.inventoryCatalogue.findItem(body.itemId);
      if (item === undefined) {
        throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
          { field: 'body.itemId', code: 'item_not_found', message: 'This item does not exist.' },
        ]);
      }
      const input = {
        supplierId: params.supplierId,
        itemId: item.id,
        currencyCode: body.currencyCode,
        minQuantity: body.minQuantity,
        unitPrice: body.unitPrice,
        validFrom: body.validFrom,
        validTo: body.validTo,
      };
      if ((await tx.supplierPrices.overlapping(input)) !== undefined) {
        refuseOverlap();
      }
      const created = await tx.supplierPrices.create(input, context.principal.userId);
      await audit(tx, context, 'supplier_price.added', 'supplier', params.supplierId, {
        priceId: created.id,
        itemId: item.id,
      });
      return (await priceBodies(tx, [created]))[0]!;
    });
    return { status: 201, body: price };
  },
});

async function requirePrice(tx: TenantTransaction, priceId: string): Promise<SupplierPrice> {
  const price = await tx.supplierPrices.find(priceId);
  if (price === undefined) {
    throw notFound('This price does not exist.');
  }
  return price;
}

export const updatePriceRoute = defineRoute({
  method: 'put',
  path: '/v1/purchasing/prices/:priceId',
  operationId: 'updateSupplierPrice',
  summary: 'Change a price',
  description: 'Replaces its currency, break, amount and days. Orders already written keep theirs.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  params: z.object({ priceId: z.uuid() }),
  query: noSchema,
  body: priceInput,
  responses: {
    200: { description: 'The price.', schema: priceSchema },
    404: { description: 'No such price.' },
    409: { description: 'Another price covers some of these days (`price_overlaps`).' },
  },
  handler: async ({ params, body }, context) => {
    const price = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await requirePrice(tx, params.priceId);
      const input = {
        supplierId: current.supplierId,
        itemId: current.itemId,
        currencyCode: body.currencyCode,
        minQuantity: body.minQuantity,
        unitPrice: body.unitPrice,
        validFrom: body.validFrom,
        validTo: body.validTo,
      };
      if ((await tx.supplierPrices.overlapping(input, current.id)) !== undefined) {
        refuseOverlap();
      }
      const updated = (await tx.supplierPrices.update(current.id, input))!;
      await audit(tx, context, 'supplier_price.updated', 'supplier', current.supplierId, {
        priceId: current.id,
      });
      return (await priceBodies(tx, [updated]))[0]!;
    });
    return { status: 200, body: price };
  },
});

export const removePriceRoute = defineRoute({
  method: 'delete',
  path: '/v1/purchasing/prices/:priceId',
  operationId: 'removeSupplierPrice',
  summary: 'Take a price off the list',
  description: 'Orders already written keep theirs.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  params: z.object({ priceId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Removed.' },
    404: { description: 'No such price.' },
  },
  handler: async ({ params }, context) => {
    await withTenant(context.principal.tenantId, async (tx) => {
      const current = await requirePrice(tx, params.priceId);
      await tx.supplierPrices.remove(current.id);
      await audit(tx, context, 'supplier_price.removed', 'supplier', current.supplierId, {
        priceId: current.id,
        itemId: current.itemId,
      });
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

const reorderLineSchema = z.object({
  item: itemSummarySchema,
  minimum: z.string(),
  onHand: z.string(),
  onOrder: z.string(),
  /** What brings it back to its level. */
  short: z.string(),
  /** What to order: `short`, raised to the supplier's smallest price break. */
  suggested: z.string(),
  supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** The supplier's price in force for the suggested quantity, if it has one. */
  price: z.object({ currencyCode: z.string(), unitPrice: z.string() }).nullable(),
});

export const reorderListRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/locations/:locationId/reorder',
  operationId: 'getReorderList',
  summary: 'What a location needs to get back to its reorder levels',
  description:
    'Items below their level, net of what is on order for this location (drafts, approved and partly received orders), with the quantity to order raised to the preferred supplier’s smallest price break.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  params: z.object({ locationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The lines.', schema: z.object({ items: z.array(reorderLineSchema) }) },
    404: { description: 'No such location (`location_not_found`).' },
  },
  handler: async ({ params }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const location = await requireLocation(tx, params.locationId, 'params.locationId');
      const needs = await tx.inventoryReplenishment.reorderNeeds(location.id);
      const [found, suppliers, today, settings] = await Promise.all([
        tx.inventoryCatalogue.findItems(needs.map((need) => need.itemId)),
        tx.inventoryPurchasing.findSuppliers([
          ...new Set(needs.flatMap((need) => need.preferredSupplierId ?? [])),
        ]),
        companyToday(tx),
        tx.settings.get(),
      ]);
      const items = new Map(found.map((item) => [item.id, item]));
      const supplierOf = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
      const lines = [];
      for (const need of needs) {
        const item = items.get(need.itemId);
        if (item === undefined) {
          continue;
        }
        const supplier =
          need.preferredSupplierId === null ? undefined : supplierOf.get(need.preferredSupplierId);
        let suggested = need.short;
        let price: { currencyCode: string; unitPrice: string } | null = null;
        if (supplier !== undefined) {
          const breaks = (await tx.supplierPrices.breaksOn(supplier.id, [item.id], today)).filter(
            (row) => row.currencyCode === settings.currency,
          );
          const smallest = breaks[0];
          if (smallest !== undefined && compareDecimals(suggested, smallest.minQuantity) < 0) {
            suggested = smallest.minQuantity;
          }
          const listed = await tx.supplierPrices.priceFor({
            supplierId: supplier.id,
            itemId: item.id,
            currencyCode: settings.currency,
            quantity: suggested,
            on: today,
          });
          price =
            listed === undefined
              ? null
              : { currencyCode: listed.currencyCode, unitPrice: listed.unitPrice };
        }
        lines.push({
          item: itemSummary(item),
          minimum: need.minimum,
          onHand: need.onHand,
          onOrder: need.onOrder,
          short: need.short,
          suggested,
          supplier: supplier === undefined ? null : { id: supplier.id, name: supplier.name },
          price,
        });
      }
      return lines;
    });
    return { status: 200, body: { items } };
  },
});

export const draftReorderRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/locations/:locationId/reorder',
  operationId: 'draftReorderOrders',
  summary: 'Draft purchase orders for chosen reorder lines, one per supplier',
  description:
    'Each line names an item, its supplier and a quantity. Lines are grouped into one draft per supplier, in the company currency, delivering to this location, priced from the supplier’s list where it has a price (otherwise the item’s usual cost). Approval is as usual. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'purchasing.manage',
  feature: FEATURE,
  idempotent: true,
  params: z.object({ locationId: z.uuid() }),
  query: noSchema,
  body: z.object({
    lines: z
      .array(z.object({ itemId: z.uuid(), supplierId: z.uuid(), quantity: positiveQuantitySchema }))
      .min(1)
      .max(200),
  }),
  responses: {
    201: {
      description: 'The drafts.',
      schema: z.object({
        orders: z.array(z.object({ id: z.uuid(), reference: z.string(), lines: z.number().int() })),
      }),
    },
    404: { description: 'No such location, supplier or item.' },
    422: {
      description:
        'A supplier is inactive (`supplier_inactive`) or an item repeats (`item_repeated`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const orders = await withTenant(context.principal.tenantId, (tx) =>
      draftReorders(tx, context, params.locationId, body.lines),
    );
    return { status: 201, body: { orders } };
  },
});

async function draftReorders(
  tx: TenantTransaction,
  context: RequestContext,
  locationId: string,
  lines: readonly { itemId: string; supplierId: string; quantity: string }[],
) {
  const location = await requireLocation(tx, locationId, 'params.locationId');
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
    throw unprocessable('item_repeated', 'Each item goes on one line.');
  }
  const [items, suppliers, today, settings] = await Promise.all([
    tx.inventoryCatalogue.findItems(lines.map((line) => line.itemId)),
    tx.inventoryPurchasing.findSuppliers([...new Set(lines.map((line) => line.supplierId))]),
    companyToday(tx),
    tx.settings.get(),
  ]);
  const itemOf = new Map(items.map((item) => [item.id, item]));
  const supplierOf = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const bySupplier = new Map<string, typeof lines>();
  for (const [index, line] of lines.entries()) {
    const item = itemOf.get(line.itemId);
    if (item?.archivedAt !== null) {
      throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
        {
          field: `body.lines.${index}.itemId`,
          code: 'item_not_found',
          message: 'This item does not exist.',
        },
      ]);
    }
    const supplier = supplierOf.get(line.supplierId);
    if (supplier === undefined) {
      throw new ApiError(404, 'supplier_not_found', 'This supplier does not exist.', [
        {
          field: `body.lines.${index}.supplierId`,
          code: 'supplier_not_found',
          message: 'This supplier does not exist.',
        },
      ]);
    }
    if (supplier.status !== 'active') {
      throw unprocessable('supplier_inactive', `${supplier.name} is not active.`, [
        {
          field: `body.lines.${index}.supplierId`,
          code: 'supplier_inactive',
          message: 'This supplier is inactive.',
        },
      ]);
    }
    bySupplier.set(supplier.id, [...(bySupplier.get(supplier.id) ?? []), line]);
  }
  const drafted = [];
  for (const [supplierId, supplierLines] of bySupplier) {
    const supplier = supplierOf.get(supplierId)!;
    const orderLines = [];
    for (const line of supplierLines) {
      const item = itemOf.get(line.itemId)!;
      const listed = await tx.supplierPrices.priceFor({
        supplierId,
        itemId: item.id,
        currencyCode: settings.currency,
        quantity: line.quantity,
        on: today,
      });
      orderLines.push({
        itemId: item.id,
        description: item.name,
        quantityOrdered: line.quantity,
        unitPrice: listed?.unitPrice ?? item.defaultUnitCost ?? item.averageUnitCost,
      });
    }
    const order = await tx.inventoryPurchasing.createOrder(
      {
        supplierId,
        supplierName: supplier.name,
        currencyCode: settings.currency,
        deliveryLocationId: location.id,
        notes: 'Drafted from the reorder list.',
      },
      orderLines,
      context.principal.userId,
    );
    const reference = `PO-${String(order.reference).padStart(6, '0')}`;
    await audit(tx, context, 'purchase_order.created', 'purchase_order', order.id, {
      reference,
      supplierId,
      lines: orderLines.length,
      reorderLocationId: location.id,
    });
    drafted.push({ id: order.id, reference, lines: orderLines.length });
  }
  return drafted;
}

export const priceListRoutes = [
  listPricesRoute,
  addPriceRoute,
  updatePriceRoute,
  removePriceRoute,
  reorderListRoute,
  draftReorderRoute,
];
