import { compareDecimals, itemTrackingSchema, positiveQuantitySchema } from '@integr8/core';
import {
  addDecimals,
  type Item,
  type MovementInput,
  type StockLot,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import {
  FEATURE,
  itemDetailBody,
  itemDetailSchema,
  itemSummary,
  itemSummarySchema,
  locationSummary,
  locationSummarySchema,
  TAGS,
} from './inventory.js';
import { requireStockItem, stockRefusal } from './inventory-stock.js';
import { peopleOf, personBody, personSchema } from './operations.js';
import { iso } from './schemas.js';
import { lotForCode } from './stock-lots.js';

/**
 * Serial numbers and batches on an item (ninth round; ADR-0013): switching
 * tracking on or off, the lots a location holds, and the serial lookup that
 * traces one unit from where it arrived to where it went.
 *
 * Tracking changes only when nothing is on hand, or when the request names the
 * serial numbers or batches making up every location's stock exactly — what a
 * count would find. The stock is relabelled in place by a transfer out and back
 * in at each location, which the general ledger does not see.
 */

const lotSummarySchema = z.object({
  lotId: z.uuid(),
  kind: z.enum(['serial', 'batch']),
  code: z.string(),
  expiresOn: z.iso.date().nullable(),
});

const lotSummary = (lot: StockLot) => ({
  lotId: lot.id,
  kind: lot.kind,
  code: lot.code,
  expiresOn: lot.expiresOn,
});

// ---------------------------------------------------------------------------
// Switching tracking
// ---------------------------------------------------------------------------

export const setItemTrackingRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/items/:itemId/tracking',
  operationId: 'setItemTracking',
  summary: 'Track an item by serial number or batch, or stop',
  description:
    'With nothing on hand the change is immediate. With stock, `lots` names the serial numbers or batches making up each location’s stock, adding up exactly to what is there (422 `lots_quantity_mismatch`); the stock is relabelled in place and its value is untouched. Stopping keeps the stock and forgets which unit is which. Stock items only. Send `expectedVersion` as read. Needs `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  idempotent: 'required',
  params: z.object({ itemId: z.uuid() }),
  query: noSchema,
  body: z.object({
    tracking: itemTrackingSchema,
    expectedVersion: z.number().int().positive(),
    lots: z
      .array(
        z.object({
          locationId: z.uuid(),
          code: z.string().trim().min(1).max(100),
          /** A batch's expiry day. */
          expiresOn: z.iso.date().optional(),
          /** One for a serial number. */
          quantity: positiveQuantitySchema.default('1'),
        }),
      )
      .max(2000)
      .optional(),
  }),
  responses: {
    200: { description: 'The item as it now is.', schema: itemDetailSchema },
    404: { description: 'No such item.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`), or a serial number already in stock (`serial_in_stock`).',
    },
    422: {
      description:
        'Not a stock item (`not_stock_item`); the serial numbers or batches do not make up the stock (`lots_quantity_mismatch`, `serial_single_unit`, `lot_repeated`); or a code used before for the other kind (`lot_code_taken`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await requireStockItem(tx, params.itemId, 'params.itemId');
      if (current.version !== body.expectedVersion) {
        throw versionConflict();
      }
      if (current.tracking === body.tracking) {
        return itemDetailBody(tx, principal, current);
      }
      const key = `tracking:${context.idempotencyKey ?? randomUUID()}`;
      const itemBalances = (await tx.inventoryStock.balances({ itemId: current.id })).filter(
        (row) => compareDecimals(row.onHand, '0') > 0,
      );
      for (const row of itemBalances) {
        await tx.inventoryStock.lockBalance(current.id, row.locationId);
      }
      // A tracked item's stock is what its lots hold; the two never differ.
      const lotBalances =
        current.tracking === 'none' ? [] : await tx.inventoryLots.balances({ itemId: current.id });
      const held =
        current.tracking === 'none'
          ? itemBalances
          : [
              ...lotBalances
                .reduce(
                  (sums, row) =>
                    sums.set(
                      row.locationId,
                      addDecimals(sums.get(row.locationId) ?? '0', row.onHand),
                    ),
                  new Map<string, string>(),
                )
                .entries(),
            ].map(([locationId, onHand]) => ({ locationId, onHand }));
      const locations = new Map(
        (await tx.inventoryStock.findLocations(held.map((row) => row.locationId))).map(
          (location) => [location.id, location],
        ),
      );
      const costAt = (locationId: string) =>
        locations.get(locationId)?.ownership === 'customer' ? null : current.averageUnitCost;
      const wanted =
        body.tracking === 'none'
          ? []
          : await lotsMakingUp(tx, current, body.tracking, held, body.lots ?? [], principal.userId);
      if (body.tracking === 'none' && (body.lots?.length ?? 0) > 0) {
        throw unprocessable('item_not_tracked', 'Stock that is not tracked names no lots.');
      }

      // Out under the old labels…
      const out: MovementInput[] =
        current.tracking === 'none'
          ? held.map((row) => ({
              itemId: current.id,
              locationId: row.locationId,
              kind: 'transfer_out',
              quantity: `-${row.onHand}`,
              unitCost: costAt(row.locationId),
              sourceKey: `${key}:out:${row.locationId}`,
              reason: 'Tracking changed',
            }))
          : lotBalances.map((row) => ({
              itemId: current.id,
              locationId: row.locationId,
              kind: 'transfer_out',
              quantity: `-${row.onHand}`,
              unitCost: costAt(row.locationId),
              lotId: row.lotId,
              sourceKey: `${key}:out:${row.locationId}:lot:${row.lotId}`,
              reason: 'Tracking changed',
            }));
      await tx.inventoryStock
        .post(out, { postingId: randomUUID(), actorId: principal.userId })
        .catch(stockRefusal);

      const updated = await tx.inventoryCatalogue.setTracking(
        current.id,
        body.tracking,
        body.expectedVersion,
      );
      if (updated === undefined) {
        throw versionConflict();
      }

      // …and back in under the new.
      const into: MovementInput[] =
        body.tracking === 'none'
          ? held.map((row) => ({
              itemId: current.id,
              locationId: row.locationId,
              kind: 'transfer_in',
              quantity: row.onHand,
              unitCost: costAt(row.locationId),
              sourceKey: `${key}:in:${row.locationId}`,
              reason: 'Tracking changed',
            }))
          : wanted.map((entry) => ({
              itemId: current.id,
              locationId: entry.locationId,
              kind: 'transfer_in',
              quantity: entry.quantity,
              unitCost: costAt(entry.locationId),
              lotId: entry.lot.id,
              sourceKey: `${key}:in:${entry.locationId}:lot:${entry.lot.id}`,
              reason: 'Tracking changed',
            }));
      await tx.inventoryStock
        .post(into, { postingId: randomUUID(), actorId: principal.userId })
        .catch(stockRefusal);

      await audit(tx, context, 'inventory_item.tracking_changed', 'inventory_item', current.id, {
        from: current.tracking,
        to: body.tracking,
        locations: held.map((row) => row.locationId),
        lots: wanted.length,
      });
      return itemDetailBody(tx, principal, updated);
    });
    return { status: 200, body: detail };
  },
});

/**
 * The lots named for each location, checked to make up exactly what is there:
 * every location holding stock covered, none that holds nothing named, a
 * serial number one unit, each code once.
 */
async function lotsMakingUp(
  tx: TenantTransaction,
  item: Item,
  kind: 'serial' | 'batch',
  held: readonly { locationId: string; onHand: string }[],
  specs: readonly {
    locationId: string;
    code: string;
    expiresOn?: string | undefined;
    quantity: string;
  }[],
  actorId: string,
): Promise<{ locationId: string; lot: StockLot; quantity: string }[]> {
  const onHand = new Map(held.map((row) => [row.locationId, row.onHand]));
  const named = new Map<string, string>();
  const mismatch = (locationId: string, quantity: string, lots: string): never => {
    throw unprocessable(
      'lots_quantity_mismatch',
      'The serial numbers or batches do not add up to the stock there.',
      [
        {
          field: 'body.lots',
          code: 'lots_quantity_mismatch',
          message: 'The serial numbers or batches do not add up to the stock there.',
          params: { locationId, quantity, lots },
        },
      ],
    );
  };
  const seen = new Set<string>();
  const result: { locationId: string; lot: StockLot; quantity: string }[] = [];
  for (const [index, spec] of specs.entries()) {
    const field = `body.lots.${index}`;
    if (!onHand.has(spec.locationId)) {
      mismatch(spec.locationId, '0', spec.quantity);
    }
    if (kind === 'serial' && compareDecimals(spec.quantity, '1') !== 0) {
      throw unprocessable('serial_single_unit', 'A serial number is one unit.', [
        { field, code: 'serial_single_unit', message: 'A serial number is one unit.' },
      ]);
    }
    const lot = await lotForCode(
      tx,
      item.id,
      kind,
      spec.code,
      spec.expiresOn ?? null,
      actorId,
      field,
    );
    const seenKey = kind === 'serial' ? lot.id : `${lot.id}:${spec.locationId}`;
    if (seen.has(seenKey)) {
      throw unprocessable('lot_repeated', 'Each serial number or batch is named once.', [
        { field, code: 'lot_repeated', message: 'Each serial number or batch is named once.' },
      ]);
    }
    seen.add(seenKey);
    named.set(spec.locationId, addDecimals(named.get(spec.locationId) ?? '0', spec.quantity));
    result.push({ locationId: spec.locationId, lot, quantity: spec.quantity });
  }
  for (const [locationId, quantity] of onHand) {
    const lots = named.get(locationId) ?? '0';
    if (compareDecimals(lots, quantity) !== 0) {
      mismatch(locationId, quantity, lots);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lots of an item, and the serial lookup
// ---------------------------------------------------------------------------

export const listItemLotsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/items/:itemId/lots',
  operationId: 'listItemLots',
  summary: 'The serial numbers or batches an item has in stock',
  description:
    'At one location when `locationId` is given — earliest expiry first, the order stock should leave in — or everywhere. Only what is held.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: z.object({ itemId: z.uuid() }),
  query: z.object({ locationId: z.uuid().optional() }),
  body: noSchema,
  responses: {
    200: {
      description: 'The lots and where they are.',
      schema: z.object({
        items: z.array(
          lotSummarySchema.extend({ location: locationSummarySchema, onHand: z.string() }),
        ),
      }),
    },
    404: { description: 'No such item.' },
  },
  handler: async ({ params, query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const item = await tx.inventoryCatalogue.findItem(params.itemId);
      if (item === undefined) {
        throw notFound('This item does not exist.');
      }
      const balances = await tx.inventoryLots.balances({
        itemId: item.id,
        ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
      });
      const [lots, places] = await Promise.all([
        tx.inventoryLots.find(balances.map((row) => row.lotId)),
        tx.inventoryStock.findLocations(balances.map((row) => row.locationId)),
      ]);
      const lot = new Map(lots.map((row) => [row.id, row]));
      const place = new Map(places.map((row) => [row.id, row]));
      return balances
        .flatMap((row) => {
          const found = lot.get(row.lotId);
          const where = place.get(row.locationId);
          return found === undefined || where === undefined
            ? []
            : [{ ...lotSummary(found), location: locationSummary(where), onHand: row.onHand }];
        })
        .sort(
          (a, b) =>
            (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') ||
            a.code.localeCompare(b.code),
        );
    });
    return { status: 200, body: { items } };
  },
});

export const searchLotsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/lots',
  operationId: 'searchLots',
  summary: 'Find a serial number or batch',
  description: 'Codes starting with `code`, ignoring case, across items; at most 20.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({ code: z.string().trim().min(1).max(100) }),
  body: noSchema,
  responses: {
    200: {
      description: 'The matches.',
      schema: z.object({ items: z.array(lotSummarySchema.extend({ item: itemSummarySchema })) }),
    },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const lots = await tx.inventoryLots.search(query.code);
      const item = new Map(
        (await tx.inventoryCatalogue.findItems(lots.map((row) => row.itemId))).map((row) => [
          row.id,
          row,
        ]),
      );
      return lots.flatMap((lot) => {
        const found = item.get(lot.itemId);
        return found === undefined ? [] : [{ ...lotSummary(lot), item: itemSummary(found) }];
      });
    });
    return { status: 200, body: { items } };
  },
});

const SOURCE_KINDS = [
  'manual',
  'customer_site',
  'receipt',
  'supplier_return',
  'van_request',
  'delivery',
  'assembly',
  'count',
  'job_part',
  'job_part_return',
  'tracking',
  'other',
] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What a movement's source key says it came from, and the record it names. */
export function sourceOf(sourceKey: string): { kind: SourceKind; id: string | null } {
  const [prefix = '', first = '', second = ''] = sourceKey.split(':');
  const id = (value: string) => (UUID.test(value) ? value : null);
  switch (prefix) {
    case 'manual':
      return { kind: 'manual', id: null };
    case 'customer-site':
      return { kind: 'customer_site', id: null };
    case 'receipt-line':
      return { kind: 'receipt', id: id(first) };
    case 'return':
      return { kind: 'supplier_return', id: id(second) };
    case 'van-request':
      return { kind: 'van_request', id: id(first) };
    case 'delivery-line':
      return { kind: 'delivery', id: id(first) };
    case 'assembly':
      return { kind: 'assembly', id: id(first) };
    case 'count':
      return { kind: 'count', id: id(first) };
    case 'material':
      return { kind: 'job_part', id: id(first) };
    case 'phone':
      return { kind: 'job_part', id: null };
    case 'material-return':
      return { kind: 'job_part_return', id: id(first) };
    case 'tracking':
      return { kind: 'tracking', id: null };
    default:
      return { kind: 'other', id: null };
  }
}

export const getLotRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/lots/:lotId',
  operationId: 'getLot',
  summary: 'A serial number or batch: where it is and where it has been',
  description:
    'Where it is now, and every movement oldest first with what caused it: a receipt, a transfer, a part used on a job (with the job and the asset it was fitted to), a delivery, a count.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: z.object({ lotId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The lot.',
      schema: lotSummarySchema.extend({
        item: itemSummarySchema,
        createdAt: z.iso.datetime(),
        stock: z.array(z.object({ location: locationSummarySchema, onHand: z.string() })),
        history: z.array(
          z.object({
            movementId: z.uuid(),
            at: z.iso.datetime(),
            location: locationSummarySchema.nullable(),
            kind: z.string(),
            quantity: z.string(),
            reason: z.string().nullable(),
            by: personSchema,
            source: z.object({
              kind: z.enum(SOURCE_KINDS),
              /** The receipt line, van request, delivery line, assembly order or count named. */
              id: z.uuid().nullable(),
            }),
            /** For a part used on a job, or put back: the job, and the asset it was fitted to. */
            workOrder: z.object({ id: z.uuid(), referenceLabel: z.string() }).nullable(),
            assetId: z.uuid().nullable(),
          }),
        ),
      }),
    },
    404: { description: 'No such serial number or batch.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const [lot] = await tx.inventoryLots.find([params.lotId]);
      if (lot === undefined) {
        throw notFound('This serial number or batch does not exist.');
      }
      const [item, balances, history, people] = await Promise.all([
        tx.inventoryCatalogue.findItem(lot.itemId),
        tx.inventoryLots.balances({ lotIds: [lot.id] }),
        tx.inventoryLots.history(lot.id),
        peopleOf(tx),
      ]);
      const places = new Map(
        (
          await tx.inventoryStock.findLocations([
            ...balances.map((row) => row.locationId),
            ...history.map((row) => row.locationId),
          ])
        ).map((row) => [row.id, row]),
      );
      const uses = await partsOf(
        tx,
        history.map((row) => row.sourceKey),
      );
      return {
        ...lotSummary(lot),
        item: itemSummary(item!),
        createdAt: iso(lot.createdAt),
        stock: balances.flatMap((row) => {
          const where = places.get(row.locationId);
          return where === undefined
            ? []
            : [{ location: locationSummary(where), onHand: row.onHand }];
        }),
        history: history.map((row) => {
          const source = sourceOf(row.sourceKey);
          const where = places.get(row.locationId);
          const use = uses.get(row.sourceKey);
          return {
            movementId: row.movementId,
            at: iso(row.occurredAt),
            location: where === undefined ? null : locationSummary(where),
            kind: row.kind,
            quantity: row.quantity,
            reason: row.reason,
            by: personBody(row.actorId, people),
            source: {
              kind: source.kind,
              id:
                source.kind === 'job_part' || source.kind === 'job_part_return' ? null : source.id,
            },
            workOrder: use?.workOrder ?? null,
            assetId: use?.assetId ?? null,
          };
        }),
      };
    });
    return { status: 200, body };
  },
});

/** For the movements of parts used on jobs or put back: the job and the asset, by source key. */
async function partsOf(
  tx: TenantTransaction,
  sourceKeys: readonly string[],
): Promise<
  Map<string, { workOrder: { id: string; referenceLabel: string }; assetId: string | null }>
> {
  const result = new Map<
    string,
    { workOrder: { id: string; referenceLabel: string }; assetId: string | null }
  >();
  const materials = new Map<string, Awaited<ReturnType<typeof tx.inventoryMaterials.find>>>();
  for (const sourceKey of sourceKeys) {
    const [prefix = '', first = ''] = sourceKey.split(':');
    let material;
    if ((prefix === 'material' || prefix === 'material-return') && UUID.test(first)) {
      material = materials.get(first) ?? (await tx.inventoryMaterials.find(first));
    } else if (prefix === 'phone') {
      material = await tx.inventoryMaterials.findByClientActionId(first);
    }
    if (material === undefined) {
      continue;
    }
    materials.set(material.id, material);
    const [job] = await tx.workOrders.findMany([material.workOrderId]);
    if (job !== undefined) {
      result.set(sourceKey, {
        workOrder: {
          id: job.id,
          referenceLabel: `WO-${String(job.reference).padStart(6, '0')}`,
        },
        assetId: material.assetId,
      });
    }
  }
  return result;
}

export const stockTrackingRoutes = [
  setItemTrackingRoute,
  listItemLotsRoute,
  searchLotsRoute,
  getLotRoute,
];
