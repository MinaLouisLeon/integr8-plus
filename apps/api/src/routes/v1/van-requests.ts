import { compareDecimals, holds, positiveQuantitySchema, quantitySchema } from '@integr8/core';
import {
  addDecimals,
  type MovementInput,
  type StockLocation,
  type TenantTransaction,
  type VanRequest,
  type VanRequestRefusal,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import { requireLocation, requireStockItem, stockRefusal } from './inventory-stock.js';
import {
  FEATURE,
  itemSummary,
  itemSummarySchema,
  locationSummary,
  locationSummarySchema,
  TAGS,
} from './inventory.js';
import { many, peopleOf, personBody, personSchema } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Refilling vans (eighth round; ADR-0012). An engineer asks for items for
 * their van, or takes what its reorder levels propose; a store person picks
 * them at a warehouse, possibly fewer, which transfers them to the van; the
 * engineer sees them arrive. Online only, by the product owner's decision:
 * nothing here goes through the phone's offline queue.
 */

const STATUSES = ['open', 'picked', 'cancelled'] as const;

const requestSchema = z.object({
  id: z.uuid(),
  van: locationSummarySchema.extend({ assignedTo: z.uuid().nullable() }),
  status: z.enum(STATUSES),
  notes: z.string().nullable(),
  requestedBy: personSchema,
  requestedAt: z.iso.datetime(),
  from: locationSummarySchema.nullable(),
  pickedBy: personSchema.nullable(),
  pickedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  lines: z.array(
    z.object({
      item: itemSummarySchema,
      requested: z.string(),
      /** What was sent; null until picked. */
      picked: z.string().nullable(),
    }),
  ),
  can: z.object({ pick: z.boolean(), cancel: z.boolean() }),
});

const mayPick = (context: RequestContext) => holds(context.principal, 'inventory.move');

async function requestBodies(
  tx: TenantTransaction,
  context: RequestContext,
  requests: readonly VanRequest[],
): Promise<z.infer<typeof requestSchema>[]> {
  if (requests.length === 0) {
    return [];
  }
  const lines = await tx.inventoryReplenishment.requestLines(requests.map((request) => request.id));
  const [locations, items, people] = await Promise.all([
    tx.inventoryStock.findLocations(
      requests.flatMap((request) => [request.vanLocationId, request.fromLocationId ?? []].flat()),
    ),
    tx.inventoryCatalogue.findItems([...lines.values()].flat().map((line) => line.itemId)),
    peopleOf(tx),
  ]);
  const locationOf = new Map(locations.map((location) => [location.id, location]));
  const itemOf = new Map(items.map((item) => [item.id, item]));
  return requests.map((request) => {
    const van = locationOf.get(request.vanLocationId)!;
    const from =
      request.fromLocationId === null ? undefined : locationOf.get(request.fromLocationId);
    const open = request.status === 'open';
    return {
      id: request.id,
      van: { ...locationSummary(van), assignedTo: van.assignedTo },
      status: request.status,
      notes: request.notes,
      requestedBy: personBody(request.requestedBy, people),
      requestedAt: iso(request.createdAt),
      from: from === undefined ? null : locationSummary(from),
      pickedBy: request.pickedBy === null ? null : personBody(request.pickedBy, people),
      pickedAt: isoOrNull(request.pickedAt),
      cancelledAt: isoOrNull(request.cancelledAt),
      version: request.version,
      lines: (lines.get(request.id) ?? []).flatMap((line) => {
        const item = itemOf.get(line.itemId);
        return item === undefined
          ? []
          : [
              {
                item: itemSummary(item),
                requested: line.quantityRequested,
                picked: line.quantityPicked,
              },
            ];
      }),
      can: {
        pick: open && mayPick(context),
        cancel: open && (mayPick(context) || request.requestedBy === context.principal.userId),
      },
    };
  });
}

/** The caller's own van, or the one named by somebody who moves stock. */
async function vanFor(
  tx: TenantTransaction,
  context: RequestContext,
  vanLocationId: string | undefined,
): Promise<StockLocation> {
  if (vanLocationId !== undefined && mayPick(context)) {
    const van = await requireLocation(tx, vanLocationId, 'body.vanLocationId');
    if (van.kind !== 'van') {
      throw unprocessable('not_a_van', 'Only a van is refilled this way.');
    }
    return van;
  }
  const van = await tx.inventoryStock.vanOf(context.principal.userId);
  if (van === undefined) {
    throw unprocessable('no_van', 'You have no van assigned to you.');
  }
  return van;
}

/** Whether this seat may see this request: those who move stock, or the van's driver. */
async function readableRequest(
  tx: TenantTransaction,
  context: RequestContext,
  requestId: string,
  options: { lock?: boolean } = {},
): Promise<VanRequest> {
  const request = await tx.inventoryReplenishment.findRequest(requestId, options);
  if (request === undefined) {
    throw notFound('This request does not exist.');
  }
  if (!mayPick(context)) {
    const van = await tx.inventoryStock.findLocation(request.vanLocationId);
    if (
      van?.assignedTo !== context.principal.userId &&
      request.requestedBy !== context.principal.userId
    ) {
      throw notFound('This request does not exist.');
    }
  }
  return request;
}

function requestRefusal(result: VanRequestRefusal): never {
  if (result === 'not_found') {
    throw notFound('This request does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('request_not_open', 'This request has already been picked or cancelled.');
}

export const listVanRequestsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/van-requests',
  operationId: 'listVanRequests',
  summary: 'Requests to refill vans',
  description:
    'Open ones oldest first — the store’s queue — then the rest, newest first. Those who move stock see every van’s; an engineer sees their own van’s.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.move'],
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    status: many(z.enum(STATUSES), STATUSES.length),
    vanLocationId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The requests.', schema: z.object({ items: z.array(requestSchema) }) },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      let vanLocationId = query.vanLocationId;
      if (!mayPick(context)) {
        const van = await tx.inventoryStock.vanOf(context.principal.userId);
        if (van === undefined) {
          return [];
        }
        vanLocationId = van.id;
      }
      const requests = await tx.inventoryReplenishment.listRequests({
        statuses: query.status,
        ...(vanLocationId === undefined ? {} : { vanLocationId }),
        limit: query.limit,
      });
      return requestBodies(tx, context, requests);
    });
    return { status: 200, body: { items } };
  },
});

export const vanProposalRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/van-requests/proposal',
  operationId: 'proposeVanRequest',
  summary: 'What the caller’s van needs to get back to its reorder levels',
  description:
    'Each item below its level on the van, with what brings it back up, less what open requests already ask for. A starting point the engineer may change.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.move'],
  feature: FEATURE,
  params: noSchema,
  query: z.object({ vanLocationId: z.uuid().optional() }),
  body: noSchema,
  responses: {
    200: {
      description: 'The proposal.',
      schema: z.object({
        van: locationSummarySchema,
        lines: z.array(
          z.object({
            item: itemSummarySchema,
            onHand: z.string(),
            minimum: z.string(),
            /** Already asked for on open requests. */
            requested: z.string(),
            quantity: z.string(),
          }),
        ),
      }),
    },
    422: { description: 'The caller has no van (`no_van`).' },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const van = await vanFor(tx, context, query.vanLocationId);
      const [needs, open] = await Promise.all([
        tx.inventoryReplenishment.reorderNeeds(van.id),
        tx.inventoryReplenishment.listRequests({
          statuses: ['open'],
          vanLocationId: van.id,
          limit: 200,
        }),
      ]);
      const asked = new Map<string, string>();
      for (const lines of (
        await tx.inventoryReplenishment.requestLines(open.map((request) => request.id))
      ).values()) {
        for (const line of lines) {
          asked.set(
            line.itemId,
            addDecimals(asked.get(line.itemId) ?? '0', line.quantityRequested),
          );
        }
      }
      const items = new Map(
        (await tx.inventoryCatalogue.findItems(needs.map((need) => need.itemId))).map((item) => [
          item.id,
          item,
        ]),
      );
      return {
        van: locationSummary(van),
        lines: needs.flatMap((need) => {
          const item = items.get(need.itemId);
          const requested = asked.get(need.itemId) ?? '0';
          const quantity = addDecimals(need.short, `-${requested}`);
          return item === undefined || compareDecimals(quantity, '0') <= 0
            ? []
            : [
                {
                  item: itemSummary(item),
                  onHand: need.onHand,
                  minimum: need.minimum,
                  requested,
                  quantity,
                },
              ];
        }),
      };
    });
    return { status: 200, body };
  },
});

export const createVanRequestRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/van-requests',
  operationId: 'createVanRequest',
  summary: 'Ask the store for items for a van',
  description:
    'For the caller’s own van; those who move stock may name any van. Each item once. Online only. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.move'],
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    vanLocationId: z.uuid().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    lines: z
      .array(z.object({ itemId: z.uuid(), quantity: positiveQuantitySchema }))
      .min(1)
      .max(100),
  }),
  responses: {
    201: { description: 'The request.', schema: requestSchema },
    404: { description: 'No such item.' },
    422: {
      description:
        'No van (`no_van`), not a stock item (`not_stock_item`), or an item twice (`item_repeated`).',
    },
  },
  handler: async ({ body }, context) => {
    const request = await withTenant(context.principal.tenantId, async (tx) => {
      const van = await vanFor(tx, context, body.vanLocationId);
      if (new Set(body.lines.map((line) => line.itemId)).size !== body.lines.length) {
        throw unprocessable('item_repeated', 'Each item goes on the request once.');
      }
      for (const [index, line] of body.lines.entries()) {
        await requireStockItem(tx, line.itemId, `body.lines.${index}.itemId`);
      }
      const created = await tx.inventoryReplenishment.createRequest(
        { vanLocationId: van.id, notes: body.notes ?? null, lines: body.lines },
        context.principal.userId,
      );
      await audit(tx, context, 'van_request.created', 'inventory_location', van.id, {
        requestId: created.id,
        lines: body.lines.length,
      });
      return (await requestBodies(tx, context, [created]))[0]!;
    });
    return { status: 201, body: request };
  },
});

const requestParams = z.object({ requestId: z.uuid() });

export const getVanRequestRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/van-requests/:requestId',
  operationId: 'getVanRequest',
  summary: 'A request to refill a van',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.move'],
  feature: FEATURE,
  params: requestParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The request.', schema: requestSchema },
    404: { description: 'No such request, or not this seat’s.' },
  },
  handler: async ({ params }, context) => {
    const request = await withTenant(
      context.principal.tenantId,
      async (tx) =>
        (
          await requestBodies(tx, context, [await readableRequest(tx, context, params.requestId)])
        )[0]!,
    );
    return { status: 200, body: request };
  },
});

export const pickVanRequestRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/van-requests/:requestId/pick',
  operationId: 'pickVanRequest',
  summary: 'Send a van what was picked for it',
  description:
    'Transfers what was picked of each line from one of our warehouses to the van, together; a line may be sent short or not at all, never more than asked. Nothing goes below zero (409 `insufficient_stock`). Only an open request (409 `request_not_open`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  params: requestParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    fromLocationId: z.uuid(),
    lines: z.array(z.object({ itemId: z.uuid(), quantity: quantitySchema })).max(100),
  }),
  responses: {
    200: { description: 'The request, picked.', schema: requestSchema },
    404: { description: 'No such request or location.' },
    409: {
      description:
        'Changed elsewhere (`version_conflict`), already picked or cancelled (`request_not_open`), or not enough stock (`insufficient_stock`).',
    },
    422: {
      description:
        'Not a warehouse of ours (`not_a_warehouse`), an item not on the request (`item_not_requested`), or more than asked (`over_request`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const request = await withTenant(principal.tenantId, async (tx) => {
      const current = await readableRequest(tx, context, params.requestId, { lock: true });
      if (current.status !== 'open') {
        requestRefusal('not_open');
      }
      if (current.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const from = await requireLocation(tx, body.fromLocationId, 'body.fromLocationId');
      if (from.kind !== 'warehouse' || from.ownership !== 'ours') {
        throw unprocessable('not_a_warehouse', 'Pick from one of our warehouses.', [
          {
            field: 'body.fromLocationId',
            code: 'not_a_warehouse',
            message: 'Choose a warehouse.',
          },
        ]);
      }
      const requested = new Map(
        ((await tx.inventoryReplenishment.requestLines([current.id])).get(current.id) ?? []).map(
          (line) => [line.itemId, line],
        ),
      );
      const picked = new Map<string, string>([...requested.keys()].map((itemId) => [itemId, '0']));
      for (const [index, line] of body.lines.entries()) {
        const asked = requested.get(line.itemId);
        if (asked === undefined) {
          throw unprocessable('item_not_requested', 'This item is not on the request.', [
            {
              field: `body.lines.${index}.itemId`,
              code: 'item_not_requested',
              message: 'This item is not on the request.',
            },
          ]);
        }
        if (compareDecimals(line.quantity, asked.quantityRequested) > 0) {
          throw unprocessable('over_request', 'That is more than was asked for.', [
            {
              field: `body.lines.${index}.quantity`,
              code: 'over_request',
              message: `At most ${asked.quantityRequested}.`,
              params: { requested: asked.quantityRequested },
            },
          ]);
        }
        picked.set(line.itemId, line.quantity);
      }
      const items = new Map(
        (await tx.inventoryCatalogue.findItems([...picked.keys()])).map((item) => [item.id, item]),
      );
      const movements: MovementInput[] = [...picked].flatMap(([itemId, quantity]) => {
        const item = items.get(itemId);
        if (item === undefined || compareDecimals(quantity, '0') <= 0) {
          return [];
        }
        const key = `van-request:${current.id}:${itemId}`;
        return [
          {
            itemId,
            locationId: from.id,
            kind: 'transfer_out' as const,
            quantity: `-${quantity}`,
            unitCost: item.averageUnitCost,
            sourceKey: `${key}:out`,
            reason: 'Van refill',
          },
          {
            itemId,
            locationId: current.vanLocationId,
            kind: 'transfer_in' as const,
            quantity,
            unitCost: item.averageUnitCost,
            sourceKey: `${key}:in`,
            reason: 'Van refill',
          },
        ];
      });
      await tx.inventoryStock
        .post(movements, { postingId: current.id, actorId: principal.userId })
        .catch(stockRefusal);
      const result = await tx.inventoryReplenishment.markPicked(
        current.id,
        body.expectedVersion,
        { fromLocationId: from.id, picked },
        principal.userId,
      );
      if (typeof result === 'string') {
        requestRefusal(result);
      }
      await audit(tx, context, 'van_request.picked', 'inventory_location', current.vanLocationId, {
        requestId: current.id,
        fromLocationId: from.id,
        lines: movements.length / 2,
      });
      return (await requestBodies(tx, context, [result]))[0]!;
    });
    return { status: 200, body: request };
  },
});

export const cancelVanRequestRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/van-requests/:requestId/cancel',
  operationId: 'cancelVanRequest',
  summary: 'Withdraw a request before it is picked',
  description: 'By whoever asked, or by somebody who moves stock.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.move'],
  feature: FEATURE,
  params: requestParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The request, cancelled.', schema: requestSchema },
    403: { description: 'Not this seat’s to withdraw.' },
    404: { description: 'No such request.' },
    409: { description: 'Changed, picked or cancelled already.' },
  },
  handler: async ({ params, body }, context) => {
    const request = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await readableRequest(tx, context, params.requestId, { lock: true });
      if (!mayPick(context) && current.requestedBy !== context.principal.userId) {
        throw forbidden('Only whoever asked, or the store, withdraws a request.');
      }
      const result = await tx.inventoryReplenishment.cancel(
        current.id,
        body.expectedVersion,
        context.principal.userId,
      );
      if (typeof result === 'string') {
        requestRefusal(result);
      }
      await audit(
        tx,
        context,
        'van_request.cancelled',
        'inventory_location',
        current.vanLocationId,
        {
          requestId: current.id,
        },
      );
      return (await requestBodies(tx, context, [result]))[0]!;
    });
    return { status: 200, body: request };
  },
});

export const vanRequestRoutes = [
  listVanRequestsRoute,
  vanProposalRoute,
  createVanRequestRoute,
  getVanRequestRoute,
  pickVanRequestRoute,
  cancelVanRequestRoute,
];
