import {
  compareDecimals,
  formatDeliveryReference,
  formatSalesOrderReference,
  positiveQuantitySchema,
  salesOrderOpen,
} from '@integr8/core';
import {
  addDecimals,
  type MovementInput,
  type SalesDelivery,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import { companyName } from './finance-invoices.js';
import { requireLocation, stockRefusal } from './inventory-stock.js';
import { locationSummary, locationSummarySchema } from './inventory.js';
import { addressSchema, peopleOf, personBody, personSchema } from './operations.js';
import { orderDetail, salesOrderDetailSchema } from './sales-orders.js';
import { companyToday, FEATURE, TAGS } from './sales-quotes.js';
import { iso } from './schemas.js';
import { byLot, lotSpecsSchema, lotsLeaving } from './stock-lots.js';

/**
 * Deliveries by hand on sales orders (eighth round; ADR-0012): whoever
 * manages orders hands over some or all of the lines from one of our
 * locations — its reservation first — never more than was ordered. Stock
 * leaves as a sale, at its average cost, and a delivery note can be printed.
 */

const deliveryLineSchema = z.object({
  orderLineId: z.uuid(),
  description: z.string(),
  sku: z.string().nullable(),
  unit: z.string(),
  quantity: z.string(),
  /** The serial numbers or batches handed over (ADR-0013), for the note. */
  lots: z.array(
    z.object({
      kind: z.enum(['serial', 'batch']),
      code: z.string(),
      expiresOn: z.iso.date().nullable(),
      quantity: z.string(),
    }),
  ),
});

const deliverySummarySchema = z.object({
  id: z.uuid(),
  /** `DN-000012`. */
  reference: z.string(),
  location: locationSummarySchema,
  deliveredBy: personSchema,
  deliveredAt: z.iso.datetime(),
  lines: z.array(deliveryLineSchema),
});

const deliveryNoteSchema = deliverySummarySchema.extend({
  notes: z.string().nullable(),
  order: z.object({
    id: z.uuid(),
    /** `SO-000034`. */
    reference: z.string(),
    title: z.string(),
  }),
  customer: z.object({ id: z.uuid(), name: z.string(), address: addressSchema.nullable() }),
  site: z.object({ id: z.uuid(), name: z.string(), address: addressSchema.nullable() }).nullable(),
  company: z.object({
    name: z.string(),
    address: z.string().nullable(),
    taxReference: z.string().nullable(),
  }),
});

async function deliveryBodies(tx: TenantTransaction, deliveries: readonly SalesDelivery[]) {
  if (deliveries.length === 0) {
    return [];
  }
  const [lines, locations, people] = await Promise.all([
    tx.salesDeliveries.lines(deliveries.map((delivery) => delivery.id)),
    tx.inventoryStock.findLocations(deliveries.map((delivery) => delivery.locationId)),
    peopleOf(tx),
  ]);
  const orderLines = new Map(
    (
      await Promise.all(
        [...new Set(deliveries.map((delivery) => delivery.orderId))].map((id) =>
          tx.salesOrders.orderLines(id),
        ),
      )
    )
      .flat()
      .map((line) => [line.id, line]),
  );
  const items = new Map(
    (
      await tx.inventoryCatalogue.findItems(
        [...orderLines.values()].flatMap((line) => line.itemId ?? []),
      )
    ).map((item) => [item.id, item]),
  );
  const locationOf = new Map(locations.map((location) => [location.id, location]));
  const lotsOfLine = new Map<string, { lotId: string; quantity: string }[]>();
  for (const line of lines) {
    const moved = await tx.inventoryLots.movedBySource(`delivery-line:${line.id}:lot:`);
    if (moved.length > 0) {
      lotsOfLine.set(line.id, moved);
    }
  }
  const lotOf = new Map(
    (await tx.inventoryLots.find([...lotsOfLine.values()].flat().map((row) => row.lotId))).map(
      (lot) => [lot.id, lot],
    ),
  );
  return deliveries.map((delivery) => ({
    id: delivery.id,
    reference: formatDeliveryReference(delivery.reference),
    location: locationSummary(locationOf.get(delivery.locationId)!),
    deliveredBy: personBody(delivery.deliveredBy, people),
    deliveredAt: iso(delivery.deliveredAt),
    lines: lines
      .filter((line) => line.deliveryId === delivery.id)
      .map((line) => {
        const orderLine = orderLines.get(line.orderLineId);
        const item = orderLine?.itemId === null ? undefined : items.get(orderLine?.itemId ?? '');
        return {
          orderLineId: line.orderLineId,
          description: orderLine?.description ?? '',
          sku: item?.sku ?? null,
          unit: orderLine?.unit ?? 'each',
          quantity: line.quantity,
          lots: (lotsOfLine.get(line.id) ?? []).flatMap((moved) => {
            const lot = lotOf.get(moved.lotId);
            return lot === undefined
              ? []
              : [
                  {
                    kind: lot.kind,
                    code: lot.code,
                    expiresOn: lot.expiresOn,
                    quantity: moved.quantity.replace(/^-/u, ''),
                  },
                ];
          }),
        };
      }),
  }));
}

const orderParams = z.object({ orderId: z.uuid() });

export const deliverSalesOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/sales/orders/:orderId/deliveries',
  operationId: 'deliverSalesOrder',
  summary: 'Hand over some or all of an order’s lines from one location',
  description:
    'Each line delivers part or all of what is left of an order line (422 `over_delivery`). Stock lines leave the chosen location as a sale, taking from this order’s reservation there first and never from what other orders hold (409 `insufficient_stock`); other lines are simply delivered. The order moves on to partly fulfilled or fulfilled. Only an open order (409 `order_not_open`), from one of our locations (422 `customer_stock_location`). Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.manage',
  feature: FEATURE,
  idempotent: true,
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    locationId: z.uuid(),
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z
      .array(
        z.object({
          orderLineId: z.uuid(),
          quantity: positiveQuantitySchema,
          /** For a tracked item: which serial numbers or batches; the earliest expiry when none are named. */
          lots: lotSpecsSchema.optional(),
          /** Hand over an expired batch anyway; the notes say why. */
          allowExpired: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  responses: {
    201: {
      description: 'The delivery, and the order as it is now.',
      schema: z.object({ delivery: deliverySummarySchema, order: salesOrderDetailSchema }),
    },
    404: { description: 'No such order, line or location.' },
    409: {
      description:
        'Not open (`order_not_open`), changed elsewhere (`version_conflict`), or not enough free stock (`insufficient_stock`).',
    },
    422: {
      description:
        'More than is left to deliver (`over_delivery`), a line twice (`line_repeated`), or a location holding the customer’s stock (`customer_stock_location`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const order = await tx.salesOrders.lockOrder(params.orderId);
      if (order === undefined) {
        throw notFound('This sales order does not exist.');
      }
      if (!salesOrderOpen(order.status)) {
        throw conflict('order_not_open', 'Only a confirmed order is delivered.');
      }
      if (order.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const location = await requireLocation(tx, body.locationId);
      if (location.ownership === 'customer') {
        throw unprocessable(
          'customer_stock_location',
          'This location holds the customer’s stock. Deliver from one of ours.',
          [
            {
              field: 'body.locationId',
              code: 'customer_stock_location',
              message: 'Choose one of our locations.',
            },
          ],
        );
      }
      if (new Set(body.lines.map((line) => line.orderLineId)).size !== body.lines.length) {
        throw unprocessable('line_repeated', 'Each order line goes on the delivery once.');
      }
      const orderLines = new Map(
        (await tx.salesOrders.orderLines(order.id)).map((line) => [line.id, line]),
      );
      const items = new Map(
        (
          await tx.inventoryCatalogue.findItems(
            [...orderLines.values()].flatMap((line) => line.itemId ?? []),
          )
        ).map((item) => [item.id, item]),
      );
      const planned = [];
      for (const [index, input] of body.lines.entries()) {
        const line = orderLines.get(input.orderLineId);
        if (line === undefined) {
          throw new ApiError(404, 'line_not_found', 'This line is not on the order.', [
            {
              field: `body.lines.${index}.orderLineId`,
              code: 'line_not_found',
              message: 'This line is not on the order.',
            },
          ]);
        }
        const left = addDecimals(line.quantity, `-${line.quantityFulfilled}`);
        if (compareDecimals(input.quantity, left) > 0) {
          throw unprocessable('over_delivery', 'That is more than is left to deliver.', [
            {
              field: `body.lines.${index}.quantity`,
              code: 'over_delivery',
              message: `At most ${left}.`,
              params: { left },
            },
          ]);
        }
        const item = line.itemId === null ? undefined : items.get(line.itemId);
        const stock = item?.kind === 'stock_item' ? item : undefined;
        if (stock !== undefined) {
          const held = await tx.inventoryStock.lockBalance(stock.id, location.id);
          const elsewhere = await tx.salesOrders.reservedElsewhere(stock.id, location.id, [
            order.id,
          ]);
          const free = addDecimals(held, `-${elsewhere}`);
          if (compareDecimals(input.quantity, free) > 0) {
            throw conflict(
              'insufficient_stock',
              `${stock.name}: only ${compareDecimals(free, '0') < 0 ? '0' : free} free at ${location.name}.`,
            );
          }
        }
        planned.push({ input, line, stock });
      }

      const created = await tx.salesDeliveries.create(
        {
          orderId: order.id,
          locationId: location.id,
          notes: body.notes ?? null,
          lines: planned.map(({ input, stock }) => ({
            orderLineId: input.orderLineId,
            quantity: input.quantity,
            unitCost: stock?.averageUnitCost ?? null,
          })),
        },
        principal.userId,
      );
      const lineIdOf = new Map(created.lines.map((line) => [line.orderLineId, line.id]));
      const movements: MovementInput[] = [];
      const today = await companyToday(tx);
      for (const [index, { input, stock }] of planned.entries()) {
        if (stock === undefined) {
          continue;
        }
        const leaving = await lotsLeaving(tx, stock, location.id, input.quantity, input.lots, {
          today,
          allowExpired: input.allowExpired,
          reason: body.notes,
          field: `body.lines.${index}.lots`,
        });
        movements.push(
          ...byLot(
            {
              itemId: stock.id,
              locationId: location.id,
              kind: 'issue',
              quantity: `-${input.quantity}`,
              unitCost: stock.averageUnitCost,
              sourceKey: `delivery-line:${lineIdOf.get(input.orderLineId)!}`,
              reason: `${formatDeliveryReference(created.delivery.reference)} for ${formatSalesOrderReference(order.reference)}`,
            },
            leaving,
          ),
        );
      }
      await tx.inventoryStock
        .post(movements, { postingId: created.delivery.id, actorId: principal.userId })
        .catch(stockRefusal);
      for (const { input } of planned) {
        await tx.salesDeliveries.fulfilLine(input.orderLineId, input.quantity, location.id);
      }
      const updated = await tx.salesOrders.refreshStatus(order.id);
      await audit(tx, context, 'sales_order.delivered', 'sales_order', order.id, {
        deliveryId: created.delivery.id,
        reference: formatDeliveryReference(created.delivery.reference),
        locationId: location.id,
        lines: planned.length,
      });
      return {
        delivery: (await deliveryBodies(tx, [created.delivery]))[0]!,
        order: await orderDetail(tx, principal, updated),
      };
    });
    return { status: 201, body: result };
  },
});

export const listDeliveriesRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/orders/:orderId/deliveries',
  operationId: 'listSalesOrderDeliveries',
  summary: 'An order’s deliveries by hand',
  description: 'Oldest first, each with its lines.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The deliveries.',
      schema: z.object({ items: z.array(deliverySummarySchema) }),
    },
    404: { description: 'No such sales order.' },
  },
  handler: async ({ params }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      if ((await tx.salesOrders.findOrder(params.orderId)) === undefined) {
        throw notFound('This sales order does not exist.');
      }
      return deliveryBodies(tx, await tx.salesDeliveries.forOrder(params.orderId));
    });
    return { status: 200, body: { items } };
  },
});

export const getDeliveryNoteRoute = defineRoute({
  method: 'get',
  path: '/v1/sales/deliveries/:deliveryId',
  operationId: 'getDeliveryNote',
  summary: 'A delivery note, ready to print',
  description:
    'What was handed over, from where, by whom and when, with the order, the customer, the site and the company’s details. No prices.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'sales.read',
  feature: FEATURE,
  params: z.object({ deliveryId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The note.', schema: deliveryNoteSchema },
    404: { description: 'No such delivery.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const delivery = await tx.salesDeliveries.find(params.deliveryId);
      if (delivery === undefined) {
        throw notFound('This delivery does not exist.');
      }
      const order = (await tx.salesOrders.findOrder(delivery.orderId))!;
      const [summary, customer, site, settings] = await Promise.all([
        deliveryBodies(tx, [delivery]),
        tx.customers.find(order.customerId),
        order.siteId === null ? undefined : tx.sites.find(order.siteId),
        tx.financeInvoices.settings(),
      ]);
      return {
        ...summary[0]!,
        notes: delivery.notes,
        order: {
          id: order.id,
          reference: formatSalesOrderReference(order.reference),
          title: order.title,
        },
        customer: {
          id: order.customerId,
          name: order.customerName ?? customer?.name ?? '',
          address: order.customerAddress ?? customer?.address ?? null,
        },
        site: site === undefined ? null : { id: site.id, name: site.name, address: site.address },
        company: {
          name: settings.legalName ?? (await companyName(principal.tenantId)),
          address: settings.address,
          taxReference: settings.taxReference,
        },
      };
    });
    return { status: 200, body };
  },
});

export const salesDeliveryRoutes = [
  deliverSalesOrderRoute,
  listDeliveriesRoute,
  getDeliveryNoteRoute,
];
