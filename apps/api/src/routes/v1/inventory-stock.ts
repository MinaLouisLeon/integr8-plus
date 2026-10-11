import {
  holds,
  MOVEMENT_KINDS,
  movementKindSchema,
  positiveQuantitySchema,
  quantitySchema,
  STOCK_COUNT_STATUSES,
  stockCountStatusSchema,
  decimalAmountSchema,
} from '@integr8/core';
import {
  DuplicatePostingError,
  InsufficientStockError,
  type Item,
  type Movement,
  type MovementInput,
  NotStockItemError,
  type StockCount,
  type StockLocation,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import {
  availability,
  FEATURE,
  itemSummary,
  itemSummarySchema,
  locationSummary,
  locationSummarySchema,
  reservedAt,
  seesCosts,
  TAGS,
} from './inventory.js';
import { booleanQuery, many } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Moving stock, balances and stock counts (CRM/ERP plan, phase E1; ADR-0003).
 *
 * Every movement goes through the ledger in `@integr8/db`, which refuses one
 * that would take stock below zero (409 `insufficient_stock`) or repeats a
 * posting. Posting requires an `Idempotency-Key`: the same request retried
 * returns the first answer and moves nothing twice.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const movementSchema = z.object({
  id: z.uuid(),
  postingId: z.uuid(),
  item: itemSummarySchema,
  location: locationSummarySchema,
  kind: movementKindSchema,
  /** Signed decimal string: positive added stock here, negative took it away. */
  quantity: z.string(),
  /** Null to seats that may not see costs. */
  unitCost: z.string().nullable(),
  reason: z.string().nullable(),
  actorId: z.uuid(),
  occurredAt: z.iso.datetime(),
});

export async function movementBodies(
  tx: TenantTransaction,
  movements: readonly Movement[],
  seeCosts: boolean,
): Promise<z.infer<typeof movementSchema>[]> {
  const [items, locations] = await Promise.all([
    tx.inventoryCatalogue.findItems(movements.map((row) => row.itemId)),
    tx.inventoryStock.findLocations(movements.map((row) => row.locationId)),
  ]);
  const item = new Map(items.map((row) => [row.id, row]));
  const location = new Map(locations.map((row) => [row.id, row]));
  return movements.map((movement) => ({
    id: movement.id,
    postingId: movement.postingId,
    item: itemSummary(item.get(movement.itemId)!),
    location: locationSummary(location.get(movement.locationId)!),
    kind: movement.kind,
    quantity: movement.quantity,
    unitCost: seeCosts ? movement.unitCost : null,
    reason: movement.reason,
    actorId: movement.actorId,
    occurredAt: iso(movement.occurredAt),
  }));
}

/** The ledger's refusals, said in words. */
export function stockRefusal(error: unknown): never {
  if (error instanceof InsufficientStockError) {
    throw conflict(
      'insufficient_stock',
      'There is not enough stock there for this. Nothing was moved.',
    );
  }
  if (error instanceof DuplicatePostingError) {
    throw conflict('already_posted', 'This has already been posted. Nothing was moved twice.');
  }
  if (error instanceof NotStockItemError) {
    throw unprocessable('not_stock_item', 'Only stock items have stock.');
  }
  throw error;
}

/** A live stock item of this company. */
export async function requireStockItem(
  tx: TenantTransaction,
  itemId: string,
  field = 'body.itemId',
): Promise<Item> {
  const item = await tx.inventoryCatalogue.findItem(itemId);
  if (item === undefined) {
    throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
      { field, code: 'item_not_found', message: 'This item does not exist.' },
    ]);
  }
  if (item.kind !== 'stock_item') {
    throw unprocessable('not_stock_item', 'Only stock items have stock.', [
      { field, code: 'not_stock_item', message: 'Only stock items have stock.' },
    ]);
  }
  if (item.archivedAt !== null) {
    throw unprocessable('item_archived', 'This item is archived. Restore it first.');
  }
  return item;
}

/** A live location of this company. */
export async function requireLocation(
  tx: TenantTransaction,
  locationId: string,
  field = 'body.locationId',
): Promise<StockLocation> {
  const location = await tx.inventoryStock.findLocation(locationId);
  if (location === undefined) {
    throw new ApiError(404, 'location_not_found', 'This location does not exist.', [
      { field, code: 'location_not_found', message: 'This location does not exist.' },
    ]);
  }
  if (location.archivedAt !== null) {
    throw unprocessable('location_archived', 'This location is archived. Restore it first.', [
      { field, code: 'location_archived', message: 'This location is archived.' },
    ]);
  }
  return location;
}

/** Negates a positive decimal string. */
const negative = (quantity: string) => `-${quantity}`;

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export const listMovementsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/movements',
  operationId: 'listStockMovements',
  summary: 'The stock ledger',
  description: 'Newest first, a page at a time.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    itemId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    kind: many(movementKindSchema, MOVEMENT_KINDS.length),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of movements.',
      schema: z.object({ items: z.array(movementSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeAtCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.inventoryStock.listMovements({
        ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
        ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
        kinds: query.kind,
        ...(after === undefined ? {} : { after: { occurredAt: after.at, id: after.id } }),
        limit: query.limit,
      });
      return {
        items: await movementBodies(tx, page.items, seesCosts(context.principal)),
        nextCursor: encodeAtCursor(
          page.next === undefined ? undefined : { at: page.next.occurredAt, id: page.next.id },
        ),
      };
    });
    return { status: 200, body };
  },
});

const postMovementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('receipt'),
    itemId: z.uuid(),
    locationId: z.uuid(),
    quantity: positiveQuantitySchema,
    /** What one unit cost, in the company currency. Folds into the average cost. */
    unitCost: decimalAmountSchema.optional(),
    reason: z.string().trim().max(1000).optional(),
  }),
  z.object({
    type: z.literal('issue'),
    itemId: z.uuid(),
    locationId: z.uuid(),
    quantity: positiveQuantitySchema,
    reason: z.string().trim().min(1).max(1000),
  }),
  z.object({
    type: z.literal('transfer'),
    itemId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    quantity: positiveQuantitySchema,
    reason: z.string().trim().max(1000).optional(),
  }),
  z.object({
    type: z.literal('adjustment'),
    itemId: z.uuid(),
    locationId: z.uuid(),
    direction: z.enum(['in', 'out']),
    quantity: positiveQuantitySchema,
    reason: z.string().trim().min(1).max(1000),
  }),
]);

export const postMovementRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/movements',
  operationId: 'postStockMovement',
  summary: 'Receive, issue, transfer or adjust stock',
  description:
    'Writes to the ledger: a receipt (optionally priced, which folds into the average cost), an issue, a transfer (both halves together), or an adjustment in or out. Issues and adjustments need a reason. Nothing goes below zero (409 `insufficient_stock`). Needs `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  idempotent: 'required',
  params: noSchema,
  query: noSchema,
  body: postMovementSchema,
  responses: {
    201: {
      description: 'What was posted.',
      schema: z.object({ postingId: z.uuid(), movements: z.array(movementSchema) }),
    },
    404: { description: 'No such item (`item_not_found`) or location (`location_not_found`).' },
    409: { description: 'Not enough stock (`insufficient_stock`).' },
    422: {
      description:
        'Invalid; not a stock item (`not_stock_item`); archived (`item_archived`, `location_archived`); or a transfer to where it already is (`same_location`).',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const posted = await withTenant(principal.tenantId, async (tx) => {
      const item = await requireStockItem(tx, body.itemId);
      const key = `manual:${context.idempotencyKey ?? randomUUID()}`;
      const postingId = randomUUID();
      let movements: MovementInput[];
      if (body.type === 'transfer') {
        if (body.fromLocationId === body.toLocationId) {
          throw unprocessable('same_location', 'Transfer to a different location.');
        }
        await requireLocation(tx, body.fromLocationId, 'body.fromLocationId');
        await requireLocation(tx, body.toLocationId, 'body.toLocationId');
        movements = [
          {
            itemId: item.id,
            locationId: body.fromLocationId,
            kind: 'transfer_out',
            quantity: negative(body.quantity),
            unitCost: item.averageUnitCost,
            sourceKey: `${key}:out`,
            reason: body.reason ?? null,
          },
          {
            itemId: item.id,
            locationId: body.toLocationId,
            kind: 'transfer_in',
            quantity: body.quantity,
            unitCost: item.averageUnitCost,
            sourceKey: `${key}:in`,
            reason: body.reason ?? null,
          },
        ];
      } else {
        await requireLocation(tx, body.locationId);
        let unitCost = item.averageUnitCost;
        if (body.type === 'receipt' && body.unitCost !== undefined) {
          await tx.inventoryStock.applyReceiptCost(item.id, body.quantity, body.unitCost);
          unitCost = body.unitCost;
        }
        movements = [
          {
            itemId: item.id,
            locationId: body.locationId,
            kind: body.type === 'adjustment' ? 'adjustment' : body.type,
            quantity:
              body.type === 'issue' || (body.type === 'adjustment' && body.direction === 'out')
                ? negative(body.quantity)
                : body.quantity,
            unitCost,
            sourceKey: key,
            reason: body.reason ?? null,
          },
        ];
      }
      const written = await tx.inventoryStock
        .post(movements, { postingId, actorId: principal.userId })
        .catch(stockRefusal);
      await audit(tx, context, `inventory_stock.${body.type}`, 'inventory_item', item.id, {
        postingId,
        quantity: body.quantity,
        locations: movements.map((movement) => movement.locationId),
      });
      return {
        postingId,
        movements: await movementBodies(tx, written, seesCosts(principal)),
      };
    });
    return { status: 201, body: posted };
  },
});

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export const listBalancesRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/balances',
  operationId: 'listStockBalances',
  summary: 'How much is where',
  description:
    '`belowMinimum=true` lists everything below its reorder level, including what has none at all.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    itemId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    belowMinimum: booleanQuery,
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'Balances.',
      schema: z.object({
        items: z.array(
          z.object({
            item: itemSummarySchema,
            location: locationSummarySchema,
            onHand: z.string(),
            /** Promised to confirmed sales orders (ADR-0006); `0` without the sales module. */
            reserved: z.string(),
            /** On hand less reserved, never below zero. */
            available: z.string(),
            minimum: z.string().nullable(),
          }),
        ),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const balances = await tx.inventoryStock.balances({
        ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
        ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
        belowMinimum: query.belowMinimum === 'true',
      });
      const [found, places, reserved] = await Promise.all([
        tx.inventoryCatalogue.findItems(balances.map((row) => row.itemId)),
        tx.inventoryStock.findLocations(balances.map((row) => row.locationId)),
        reservedAt(tx, {
          ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
          ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
        }),
      ]);
      const item = new Map(found.map((row) => [row.id, row]));
      const location = new Map(places.map((row) => [row.id, row]));
      return balances
        .flatMap((row) => {
          const i = item.get(row.itemId);
          const l = location.get(row.locationId);
          return i === undefined || l === undefined
            ? []
            : [
                {
                  item: itemSummary(i),
                  location: locationSummary(l),
                  onHand: row.onHand,
                  ...availability(row.onHand, reserved.get(`${row.itemId}:${row.locationId}`)),
                  minimum: row.minimum,
                },
              ];
        })
        .sort(
          (a, b) =>
            a.item.name.localeCompare(b.item.name) ||
            a.location.name.localeCompare(b.location.name),
        );
    });
    return { status: 200, body: { items } };
  },
});

export const reconcileRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/reconcile',
  operationId: 'reconcileStock',
  summary: 'Replay the ledger and check every balance',
  description: 'Empty `discrepancies` means every balance equals the sum of its movements.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Any balance that disagrees with its ledger.',
      schema: z.object({
        checkedAt: z.iso.datetime(),
        discrepancies: z.array(
          z.object({
            itemId: z.uuid(),
            locationId: z.uuid(),
            ledger: z.string(),
            balance: z.string(),
          }),
        ),
      }),
    },
  },
  handler: async (_input, context) => {
    const discrepancies = await withTenant(context.principal.tenantId, (tx) =>
      tx.inventoryStock.reconcile(),
    );
    return { status: 200, body: { checkedAt: new Date().toISOString(), discrepancies } };
  },
});

// ---------------------------------------------------------------------------
// Stock counts
// ---------------------------------------------------------------------------

const countSchema = z.object({
  id: z.uuid(),
  location: locationSummarySchema,
  status: stockCountStatusSchema,
  notes: z.string().nullable(),
  version: z.number().int(),
  createdBy: z.uuid(),
  postedBy: z.uuid().nullable(),
  postedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

async function countBodies(tx: TenantTransaction, counts: readonly StockCount[]) {
  const locations = new Map(
    (await tx.inventoryStock.findLocations(counts.map((count) => count.locationId))).map(
      (location) => [location.id, location],
    ),
  );
  return counts.map((count) => ({
    id: count.id,
    location: locationSummary(locations.get(count.locationId)!),
    status: count.status,
    notes: count.notes,
    version: count.version,
    createdBy: count.createdBy,
    postedBy: count.postedBy,
    postedAt: isoOrNull(count.postedAt),
    createdAt: iso(count.createdAt),
  }));
}

const countDetailSchema = z.object({
  count: countSchema,
  lines: z.array(
    z.object({
      item: itemSummarySchema,
      countedQuantity: z.string(),
      /** What the system held when it was posted; null on a draft. */
      expectedQuantity: z.string().nullable(),
      /** What the system holds now. */
      onHand: z.string(),
    }),
  ),
  can: z.object({ edit: z.boolean() }),
});

async function countDetail(tx: TenantTransaction, context: RequestContext, count: StockCount) {
  const [lines, balances] = await Promise.all([
    tx.inventoryStock.countLines(count.id),
    tx.inventoryStock.balances({ locationId: count.locationId }),
  ]);
  const items = new Map(
    (await tx.inventoryCatalogue.findItems(lines.map((line) => line.itemId))).map((item) => [
      item.id,
      item,
    ]),
  );
  const held = new Map(balances.map((row) => [row.itemId, row.onHand]));
  return {
    count: (await countBodies(tx, [count]))[0]!,
    lines: lines
      .flatMap((line) => {
        const item = items.get(line.itemId);
        return item === undefined
          ? []
          : [
              {
                item: itemSummary(item),
                countedQuantity: line.countedQuantity,
                expectedQuantity: line.expectedQuantity,
                onHand: held.get(line.itemId) ?? '0',
              },
            ];
      })
      .sort((a, b) => a.item.name.localeCompare(b.item.name)),
    can: { edit: holds(context.principal, 'inventory.move') && count.status === 'draft' },
  };
}

const countParams = z.object({ countId: z.uuid() });

function countRefusal(result: 'not_found' | 'version_conflict' | 'not_draft'): never {
  if (result === 'not_found') {
    throw notFound('This stock count does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('count_not_draft', 'This stock count has already been posted or cancelled.');
}

export const listCountsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/counts',
  operationId: 'listStockCounts',
  summary: 'Stock counts',
  description: 'Newest first.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    locationId: z.uuid().optional(),
    status: many(stockCountStatusSchema, STOCK_COUNT_STATUSES.length),
  }),
  body: noSchema,
  responses: {
    200: { description: 'Counts.', schema: z.object({ items: z.array(countSchema) }) },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) =>
      countBodies(
        tx,
        await tx.inventoryStock.listCounts({
          ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
          statuses: query.status,
        }),
      ),
    );
    return { status: 200, body: { items } };
  },
});

export const createCountRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/counts',
  operationId: 'createStockCount',
  summary: 'Start counting a location',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({ locationId: z.uuid(), notes: z.string().max(2000).nullable().optional() }),
  responses: {
    201: { description: 'The draft count.', schema: countDetailSchema },
    404: { description: 'No such location.' },
  },
  handler: async ({ body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      await requireLocation(tx, body.locationId);
      const count = await tx.inventoryStock.createCount(
        body.locationId,
        context.principal.userId,
        body.notes ?? null,
      );
      await audit(tx, context, 'inventory_count.created', 'inventory_count', count.id, {
        locationId: count.locationId,
      });
      return countDetail(tx, context, count);
    });
    return { status: 201, body: detail };
  },
});

export const getCountRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/counts/:countId',
  operationId: 'getStockCount',
  summary: 'A stock count and its lines',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: countParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The count.', schema: countDetailSchema },
    404: { description: 'No such count.' },
  },
  handler: async ({ params }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const count = await tx.inventoryStock.findCount(params.countId);
      if (count === undefined) {
        throw notFound('This stock count does not exist.');
      }
      return countDetail(tx, context, count);
    });
    return { status: 200, body: detail };
  },
});

export const setCountLinesRoute = defineRoute({
  method: 'put',
  path: '/v1/inventory/counts/:countId/lines',
  operationId: 'setStockCountLines',
  summary: 'Record what was counted',
  description: 'Replaces a draft count’s lines. Stock items only, one line each.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  params: countParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().positive(),
    lines: z
      .array(z.object({ itemId: z.uuid(), countedQuantity: quantitySchema }))
      .max(1000)
      .refine(
        (lines) => new Set(lines.map((line) => line.itemId)).size === lines.length,
        'One line per item',
      ),
  }),
  responses: {
    200: { description: 'The count.', schema: countDetailSchema },
    404: { description: 'No such count or item.' },
    409: { description: 'Changed by somebody else, or not a draft (`count_not_draft`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      for (const [index, line] of body.lines.entries()) {
        await requireStockItem(tx, line.itemId, `body.lines.${index}.itemId`);
      }
      const result = await tx.inventoryStock.setCountLines(
        params.countId,
        body.expectedVersion,
        body.lines,
      );
      if (typeof result === 'string') {
        countRefusal(result);
      }
      return countDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

export const postCountRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/counts/:countId/post',
  operationId: 'postStockCount',
  summary: 'Post a count: adjust stock to what was counted',
  description:
    'For each line, what the system holds is recorded and the difference is posted as a count adjustment naming who posted it. Items not on the count are left alone.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  params: countParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().positive() }),
  responses: {
    200: { description: 'The posted count.', schema: countDetailSchema },
    404: { description: 'No such count.' },
    409: { description: 'Changed by somebody else, or not a draft (`count_not_draft`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.inventoryStock
        .postCount(params.countId, body.expectedVersion, {
          postingId: randomUUID(),
          actorId: context.principal.userId,
        })
        .catch(stockRefusal);
      if (typeof result === 'string') {
        countRefusal(result);
      }
      await audit(tx, context, 'inventory_count.posted', 'inventory_count', result.count.id, {
        adjustments: result.movements.length,
      });
      return countDetail(tx, context, result.count);
    });
    return { status: 200, body: detail };
  },
});

export const cancelCountRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/counts/:countId/cancel',
  operationId: 'cancelStockCount',
  summary: 'Cancel a draft count',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  params: countParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().positive() }),
  responses: {
    200: { description: 'The cancelled count.', schema: countDetailSchema },
    404: { description: 'No such count.' },
    409: { description: 'Changed by somebody else, or not a draft (`count_not_draft`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.inventoryStock.cancelCount(params.countId, body.expectedVersion);
      if (typeof result === 'string') {
        countRefusal(result);
      }
      await audit(tx, context, 'inventory_count.cancelled', 'inventory_count', result.id);
      return countDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

function encodeAtCursor(next: { at: Date; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify({ at: next.at.toISOString(), id: next.id }), 'utf8').toString(
        'base64url',
      );
}

function decodeAtCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const result = z.object({ at: z.iso.datetime(), id: z.uuid() }).safeParse(parsed);
    return result.success ? { at: new Date(result.data.at), id: result.data.id } : undefined;
  } catch {
    return undefined;
  }
}

export const stockRoutes = [
  listMovementsRoute,
  postMovementRoute,
  listBalancesRoute,
  reconcileRoute,
  listCountsRoute,
  createCountRoute,
  getCountRoute,
  setCountLinesRoute,
  postCountRoute,
  cancelCountRoute,
];
