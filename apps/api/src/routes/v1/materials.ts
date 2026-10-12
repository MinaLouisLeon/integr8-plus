import {
  compareDecimals,
  formatWorkOrderReference,
  holds,
  materialStatusSchema,
  type Principal,
} from '@integr8/core';
import {
  addDecimals,
  DuplicatePostingError,
  type Item,
  type Material,
  type MaterialLot,
  type TenantTransaction,
  type WorkOrder,
} from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conflict, forbidden, unprocessable } from '../../http/errors.js';
import type { RequestContext } from '../../http/routes.js';
import { requireLocation } from './inventory-stock.js';
import { availableForJob, deliverForJob } from './sales-fulfilment.js';
import { itemSummary, itemSummarySchema, seesCosts } from './inventory.js';
import { type People, personBody, personSchema } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso } from './schemas.js';
import { byLot, type LotAllocation, type LotSpec, lotsHeld, lotsLeaving } from './stock-lots.js';

/**
 * Parts used on jobs (CRM/ERP plan, phase E2; ADR-0005): the record, and the
 * rules every way of recording a use shares — the job screen on the web or
 * desktop, and the phone's outbox through `sync/push`.
 *
 * The server decides under the balance's lock. When the location has enough
 * available — held, less what is reserved for sales orders this job is not
 * delivering (ADR-0006) — the use posts one `consumption` movement and counts
 * towards the linked orders; when it does not, nothing posts and the use is
 * kept as a conflict with what was asked for and what was available. Stock
 * never goes negative. An engineer records only on a job they are on, from
 * the van assigned to them; a dispatcher names any location.
 */

export const materialSchema = z.object({
  id: z.uuid(),
  item: itemSummarySchema,
  location: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  quantity: z.string(),
  returnedQuantity: z.string(),
  /** The item's average cost when it posted; null to seats that may not see costs. */
  unitCost: z.string().nullable(),
  status: materialStatusSchema,
  /** What the location had available — held, less what other orders reserved — when the use was refused (status `conflict`). */
  availableQuantity: z.string().nullable(),
  note: z.string().nullable(),
  recordedBy: personSchema,
  recordedAt: z.iso.datetime(),
  occurredAt: z.iso.datetime(),
  cancelledBy: personSchema.nullable(),
  /** The phone's own id for the action, when it came from the phone. */
  clientActionId: z.string().nullable(),
  version: z.number().int(),
  /**
   * The serial numbers or batches the part came from (ADR-0013): those taken
   * once posted, those asked for while a conflict; null for an untracked item.
   */
  lots: z
    .array(
      z.object({
        lotId: z.uuid(),
        kind: z.enum(['serial', 'batch']),
        code: z.string(),
        expiresOn: z.iso.date().nullable(),
        quantity: z.string(),
      }),
    )
    .nullable(),
});

export type MaterialBody = z.infer<typeof materialSchema>;

export async function materialBodies(
  tx: TenantTransaction,
  materials: readonly Material[],
  seeCosts: boolean,
  people: People,
): Promise<MaterialBody[]> {
  if (materials.length === 0) {
    return [];
  }
  const [items, locations, lots] = await Promise.all([
    tx.inventoryCatalogue.findItems(materials.map((row) => row.itemId)),
    tx.inventoryStock.findLocations(
      materials.flatMap((row) => (row.locationId === null ? [] : [row.locationId])),
    ),
    tx.inventoryLots.find(materials.flatMap((row) => (row.lots ?? []).map((lot) => lot.lotId))),
  ]);
  const item = new Map(items.map((row) => [row.id, row]));
  const location = new Map(locations.map((row) => [row.id, row]));
  const lot = new Map(lots.map((row) => [row.id, row]));
  return materials.map((material) => {
    const where = material.locationId === null ? undefined : location.get(material.locationId);
    return {
      id: material.id,
      item: itemSummary(item.get(material.itemId)!),
      location: where === undefined ? null : { id: where.id, name: where.name },
      quantity: material.quantity,
      returnedQuantity: material.returnedQuantity,
      unitCost: seeCosts ? material.unitCost : null,
      status: material.status,
      availableQuantity: material.availableQuantity,
      note: material.note,
      recordedBy: personBody(material.recordedBy, people),
      recordedAt: iso(material.recordedAt),
      occurredAt: iso(material.occurredAt),
      cancelledBy: material.cancelledBy === null ? null : personBody(material.cancelledBy, people),
      clientActionId: material.clientActionId,
      version: material.version,
      lots:
        material.lots === null
          ? null
          : material.lots.flatMap((entry) => {
              const found = lot.get(entry.lotId);
              return found === undefined
                ? []
                : [
                    {
                      lotId: found.id,
                      kind: found.kind,
                      code: found.code,
                      expiresOn: found.expiresOn,
                      quantity: entry.quantity,
                    },
                  ];
            }),
    };
  });
}

/** The engineer's van: where their parts come from. */
export async function vanBody(tx: TenantTransaction, principal: Principal) {
  const van = await tx.inventoryStock.vanOf(principal.userId);
  return van?.archivedAt !== null ? null : { id: van.id, name: van.name };
}

// ---------------------------------------------------------------------------
// Recording a use
// ---------------------------------------------------------------------------

export interface UseInput {
  itemId: string;
  /** Required of a dispatcher; an engineer's is their van, named or not. */
  locationId?: string | null;
  quantity: string;
  note?: string | null;
  /** The phone's id for the action; the same id arriving again finds the first record. */
  clientActionId?: string | null;
  occurredAt?: Date;
  /** For a serial-numbered or batched item: which ones; the earliest expiry when none are named. */
  lots?: readonly LotSpec[] | undefined;
  /** Use an expired batch anyway; the note says why. */
  allowExpired?: boolean | undefined;
}

export type UseOutcome =
  | { outcome: 'posted' | 'conflict'; material: Material }
  | { outcome: 'already_recorded'; material: Material };

/** Where this seat takes parts from: the named location for those who move stock, else their van. */
async function sourceLocation(
  tx: TenantTransaction,
  principal: Principal,
  locationId: string | null | undefined,
) {
  if (holds(principal, 'inventory.move')) {
    if (typeof locationId !== 'string') {
      throw unprocessable('location_required', 'Say where the part came from.', [
        {
          field: 'body.locationId',
          code: 'location_required',
          message: 'Say where the part came from.',
        },
      ]);
    }
    return requireLocation(tx, locationId);
  }
  const van = await tx.inventoryStock.vanOf(principal.userId);
  if (van?.archivedAt !== null) {
    throw unprocessable(
      'no_van',
      'No van is assigned to you. Ask the office to assign one before recording parts.',
    );
  }
  if (typeof locationId === 'string' && locationId !== van.id) {
    throw forbidden('Parts come from the van assigned to you.');
  }
  return van;
}

/**
 * Records a use on a job and, for a stock item, posts it or keeps it as a
 * conflict. The caller has checked that this person works the job.
 */
export async function recordUse(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
  input: UseInput,
): Promise<UseOutcome> {
  const { principal } = context;
  const clientActionId = input.clientActionId ?? null;
  if (clientActionId !== null) {
    const earlier = await tx.inventoryMaterials.findByClientActionId(clientActionId);
    if (earlier !== undefined) {
      return { outcome: 'already_recorded', material: earlier };
    }
  }
  const item = await tx.inventoryCatalogue.findItem(input.itemId);
  if (item === undefined) {
    throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
      { field: 'body.itemId', code: 'item_not_found', message: 'This item does not exist.' },
    ]);
  }
  if (item.archivedAt !== null) {
    throw unprocessable('item_archived', 'This item is archived.');
  }

  if (item.kind !== 'stock_item') {
    // Bought for the job or a service: on the record, never in the ledger.
    const material = await tx.inventoryMaterials.create({
      workOrderId: job.id,
      itemId: item.id,
      locationId: null,
      quantity: input.quantity,
      unitCost: item.defaultUnitCost,
      status: 'posted',
      clientActionId,
      note: input.note ?? null,
      recordedBy: principal.userId,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
    await audit(tx, context, 'work_order.part_used', job.id, {
      materialId: material.id,
      itemId: item.id,
      quantity: input.quantity,
      stock: false,
    });
    await deliverForJob(tx, context, job, item.id, input.quantity);
    return { outcome: 'posted', material };
  }

  const location = await sourceLocation(tx, principal, input.locationId);
  const held = await tx.inventoryStock.lockBalance(item.id, location.id);
  const { available } = await availableForJob(tx, job, item.id, location.id, held);
  let enough = compareDecimals(available, input.quantity) >= 0;
  const lots = await lotsForUse(tx, item, location.id, input.quantity, input.lots, {
    allowExpired: input.allowExpired,
    reason: input.note,
    fromPhone: clientActionId !== null,
  });
  enough &&= lots.held;
  let material: Material;
  try {
    material = await tx.inventoryMaterials.create({
      workOrderId: job.id,
      itemId: item.id,
      locationId: location.id,
      quantity: input.quantity,
      unitCost: enough ? item.averageUnitCost : null,
      status: enough ? 'posted' : 'conflict',
      availableQuantity: enough ? null : available,
      clientActionId,
      note: input.note ?? null,
      recordedBy: principal.userId,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      lots: lots.lots,
    });
  } catch (error) {
    // Two arrivals of the same phone action at once: the other one won.
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (
      code === '23505' &&
      constraint === 'erp_work_order_materials_client_action_unique' &&
      clientActionId !== null
    ) {
      const earlier = await tx.inventoryMaterials.findByClientActionId(clientActionId);
      if (earlier !== undefined) {
        return { outcome: 'already_recorded', material: earlier };
      }
    }
    throw error;
  }
  if (enough) {
    await postUse(tx, context, job, material, item.averageUnitCost);
  }
  await audit(tx, context, enough ? 'work_order.part_used' : 'work_order.part_conflict', job.id, {
    materialId: material.id,
    itemId: item.id,
    locationId: location.id,
    quantity: input.quantity,
    ...(lots.lots === null ? {} : { lots: lots.lots }),
    ...(enough ? {} : { available, held }),
    ...(clientActionId === null ? {} : { clientActionId }),
  });
  if (enough) {
    await deliverForJob(tx, context, job, item.id, input.quantity);
  }
  return { outcome: enough ? 'posted' : 'conflict', material };
}

/** Refusals a phone could not have known offline: the use is kept as a conflict instead. */
const PHONE_CLASHES = new Set(['batch_expired', 'reason_required', 'lot_not_found']);

/**
 * Which serial numbers or batches a use takes, and whether the location holds
 * them. Untracked items take none. A short location, or on the phone a lot it
 * could not have known was wrong, is a conflict rather than a refusal.
 */
async function lotsForUse(
  tx: TenantTransaction,
  item: Item,
  locationId: string,
  quantity: string,
  specs: readonly LotSpec[] | undefined,
  options: {
    allowExpired?: boolean | undefined;
    reason?: string | null | undefined;
    fromPhone: boolean;
  },
): Promise<{ lots: MaterialLot[] | null; held: boolean }> {
  if (item.tracking === 'none') {
    await lotsLeaving(tx, item, locationId, quantity, specs, { today: '' });
    return { lots: null, held: true };
  }
  let allocations: LotAllocation[];
  try {
    allocations = await lotsLeaving(tx, item, locationId, quantity, specs, {
      today: await companyToday(tx),
      allowExpired: options.allowExpired,
      reason: options.reason,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === 'insufficient_stock' || (options.fromPhone && PHONE_CLASHES.has(error.code)))
    ) {
      return { lots: null, held: false };
    }
    throw error;
  }
  const lots = allocations.flatMap((allocation) =>
    allocation.lotId === null ? [] : [{ lotId: allocation.lotId, quantity: allocation.quantity }],
  );
  return { lots, held: await lotsHeld(tx, locationId, allocations) };
}

/** The ledger key a use posts under: the phone's own id when it has one (ADR-0005). */
const useSourceKey = (material: Material) =>
  material.clientActionId === null ? `material:${material.id}` : `phone:${material.clientActionId}`;

async function postUse(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
  material: Material,
  unitCost: string,
): Promise<void> {
  try {
    await tx.inventoryStock.post(
      byLot(
        {
          itemId: material.itemId,
          locationId: material.locationId!,
          kind: 'consumption',
          quantity: `-${material.quantity}`,
          unitCost,
          sourceKey: useSourceKey(material),
          reason: formatWorkOrderReference(job.reference),
        },
        material.lots ?? [{ lotId: null, quantity: material.quantity }],
      ),
      { postingId: material.id, actorId: context.principal.userId },
    );
  } catch (error) {
    if (error instanceof DuplicatePostingError) {
      throw conflict('already_posted', 'This use has already been posted.');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Resolving a conflict, returning a part
// ---------------------------------------------------------------------------

export type Resolution =
  | { action: 'cancel' }
  | {
      action: 'retry';
      quantity?: string | undefined;
      locationId?: string | undefined;
      /** Other serial numbers or batches; those first asked for when the quantity is unchanged. */
      lots?: readonly LotSpec[] | undefined;
      allowExpired?: boolean | undefined;
      reason?: string | undefined;
    };

/**
 * Settles a use the location could not cover. Cancelling needs the recorder
 * or someone who moves stock; retrying — with a changed quantity or location
 * or after the van was corrected — needs someone who moves stock, and may
 * find the stock still short.
 */
export async function resolveUse(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
  material: Material,
  resolution: Resolution,
): Promise<UseOutcome> {
  const { principal } = context;
  if (material.status !== 'conflict') {
    throw conflict('not_a_conflict', 'Only a use that was refused is resolved this way.');
  }
  if (resolution.action === 'cancel') {
    if (material.recordedBy !== principal.userId && !holds(principal, 'inventory.move')) {
      throw forbidden('Only the person who recorded this, or the office, can cancel it.');
    }
    const cancelled = await tx.inventoryMaterials.update(material.id, {
      status: 'cancelled',
      cancelledBy: principal.userId,
    });
    await audit(tx, context, 'work_order.part_cancelled', job.id, { materialId: material.id });
    return { outcome: 'posted', material: cancelled };
  }
  if (!holds(principal, 'inventory.move')) {
    throw forbidden('Only the office can retry a refused use.');
  }
  const locationId = resolution.locationId ?? material.locationId!;
  const location = await requireLocation(tx, locationId);
  const quantity = resolution.quantity ?? material.quantity;
  const item = await tx.inventoryCatalogue.findItem(material.itemId);
  if (item?.kind !== 'stock_item') {
    throw unprocessable('not_stock_item', 'Only stock items have stock.');
  }
  const held = await tx.inventoryStock.lockBalance(item.id, location.id);
  const { available } = await availableForJob(tx, job, item.id, location.id, held);
  let enough = compareDecimals(available, quantity) >= 0;
  const asked =
    resolution.lots ??
    (resolution.quantity === undefined && material.lots !== null && material.lots.length > 0
      ? material.lots.map((lot) => ({ lotId: lot.lotId, quantity: lot.quantity }))
      : undefined);
  const lots = await lotsForUse(tx, item, location.id, quantity, asked, {
    allowExpired: resolution.allowExpired,
    reason: resolution.reason,
    fromPhone: false,
  });
  enough &&= lots.held;
  const updated = await tx.inventoryMaterials.update(material.id, {
    quantity,
    locationId: location.id,
    status: enough ? 'posted' : 'conflict',
    unitCost: enough ? item.averageUnitCost : null,
    availableQuantity: enough ? null : available,
    lots: lots.lots,
  });
  if (enough) {
    await postUse(tx, context, job, updated, item.averageUnitCost);
  }
  await audit(tx, context, 'work_order.part_retried', job.id, {
    materialId: material.id,
    quantity,
    locationId: location.id,
    outcome: enough ? 'posted' : 'conflict',
    ...(enough ? {} : { available, held }),
  });
  if (enough) {
    await deliverForJob(tx, context, job, item.id, quantity);
  }
  return { outcome: enough ? 'posted' : 'conflict', material: updated };
}

/**
 * Puts an unused part back: a `consumption_return` against the use's own
 * movement, never more than was used, under one idempotency key.
 */
export async function returnUse(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
  material: Material,
  input: {
    quantity: string;
    reason: string | null;
    idempotencyKey: string;
    /** Which serial numbers or batches come back; by default, those used, in order. */
    lots?: readonly LotSpec[] | undefined;
  },
): Promise<Material> {
  if (material.status !== 'posted') {
    throw conflict('not_posted', 'Only a posted use can be returned.');
  }
  let updated: Material;
  try {
    updated = await tx.inventoryMaterials.addReturned(material.id, input.quantity);
  } catch (error) {
    const { constraint } = error as { constraint?: string };
    if (constraint === 'erp_work_order_materials_returned_range') {
      throw unprocessable(
        'over_returned',
        'That is more than was used on this job. Nothing was recorded.',
      );
    }
    throw error;
  }
  if (material.locationId !== null && material.lots !== null && material.lots.length > 0) {
    // Serial numbers and batches go back as they came (ADR-0013).
    const allocations = await lotsReturning(tx, material, input.quantity, input.lots);
    const movements = [];
    for (const allocation of allocations) {
      const original = await tx.inventoryStock.findMovementBySourceKey(
        `${useSourceKey(material)}:lot:${allocation.lotId}`,
      );
      movements.push({
        itemId: material.itemId,
        locationId: material.locationId,
        kind: 'consumption_return' as const,
        quantity: allocation.quantity,
        unitCost: material.unitCost,
        lotId: allocation.lotId,
        sourceKey: `material-return:${material.id}:${input.idempotencyKey}:lot:${allocation.lotId}`,
        reason: input.reason ?? formatWorkOrderReference(job.reference),
        reversalOf: original?.id ?? null,
      });
    }
    await tx.inventoryStock.post(movements, {
      postingId: randomUUID(),
      actorId: context.principal.userId,
    });
  } else if (material.locationId !== null) {
    if (input.lots !== undefined && input.lots.length > 0) {
      throw unprocessable('item_not_tracked', 'This item has no serial numbers or batches.');
    }
    const original = await tx.inventoryStock.findMovementBySourceKey(useSourceKey(material));
    await tx.inventoryStock.post(
      [
        {
          itemId: material.itemId,
          locationId: material.locationId,
          kind: 'consumption_return',
          quantity: input.quantity,
          unitCost: material.unitCost,
          sourceKey: `material-return:${input.idempotencyKey}`,
          reason: input.reason ?? formatWorkOrderReference(job.reference),
          reversalOf: original?.id ?? null,
        },
      ],
      { postingId: randomUUID(), actorId: context.principal.userId },
    );
  }
  await audit(tx, context, 'work_order.part_returned', job.id, {
    materialId: material.id,
    quantity: input.quantity,
    reason: input.reason,
  });
  return updated;
}

/**
 * The serial numbers or batches a return gives back: those named, each within
 * what the use took of it less what came back before, or else the use's own
 * in order.
 */
async function lotsReturning(
  tx: TenantTransaction,
  material: Material,
  quantity: string,
  specs: readonly LotSpec[] | undefined,
): Promise<{ lotId: string; quantity: string }[]> {
  const returned = new Map(
    (await tx.inventoryLots.movedBySource(`material-return:${material.id}:`)).map((row) => [
      row.lotId,
      row.quantity,
    ]),
  );
  const left = new Map(
    material.lots!.map((lot) => [
      lot.lotId,
      addDecimals(lot.quantity, `-${returned.get(lot.lotId) ?? '0'}`),
    ]),
  );
  const over = () =>
    unprocessable('over_returned', 'That is more than was used on this job. Nothing was recorded.');
  if (specs !== undefined && specs.length > 0) {
    const named = await tx.inventoryLots.find(specs.flatMap((spec) => spec.lotId ?? []));
    const byCode = await tx.inventoryLots.byCodes(
      material.itemId,
      specs.flatMap((spec) =>
        spec.lotId === undefined && spec.code !== undefined ? [spec.code] : [],
      ),
    );
    const byId = new Map(named.map((lot) => [lot.id, lot]));
    let sum = '0';
    const allocations = specs.map((spec) => {
      const lot = spec.lotId === undefined ? byCode.get(spec.code!) : byId.get(spec.lotId);
      const remaining = lot === undefined ? undefined : left.get(lot.id);
      if (lot === undefined || remaining === undefined) {
        throw new ApiError(404, 'lot_not_found', 'This serial number or batch was not used here.');
      }
      if (compareDecimals(spec.quantity, remaining) > 0) {
        throw over();
      }
      left.set(lot.id, addDecimals(remaining, `-${spec.quantity}`));
      sum = addDecimals(sum, spec.quantity);
      return { lotId: lot.id, quantity: spec.quantity };
    });
    if (compareDecimals(sum, quantity) !== 0) {
      throw unprocessable(
        'lots_quantity_mismatch',
        'The serial numbers or batches do not add up to the quantity.',
      );
    }
    return allocations;
  }
  const allocations: { lotId: string; quantity: string }[] = [];
  let rest = quantity;
  for (const [lotId, remaining] of left) {
    if (compareDecimals(rest, '0') <= 0) {
      break;
    }
    if (compareDecimals(remaining, '0') <= 0) {
      continue;
    }
    const take = compareDecimals(remaining, rest) < 0 ? remaining : rest;
    allocations.push({ lotId, quantity: take });
    rest = addDecimals(rest, `-${take}`);
  }
  if (compareDecimals(rest, '0') > 0) {
    throw over();
  }
  return allocations;
}

/** Whether this seat sees what parts cost: the same rule as the rest of the inventory. */
export { seesCosts };

async function audit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  workOrderId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { principal } = context;
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: principal.userId,
    actorLabel: principal.userId,
    action,
    resourceType: 'work_order',
    resourceId: workOrderId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata:
      principal.impersonatedBy === undefined
        ? metadata
        : { ...metadata, impersonatedBy: principal.impersonatedBy },
  });
}
