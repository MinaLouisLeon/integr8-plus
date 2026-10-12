import { compareDecimals, positiveQuantitySchema, type UserId } from '@integr8/core';
import {
  addDecimals,
  type Item,
  type MovementInput,
  type StockLot,
  type TenantTransaction,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, unprocessable } from '../../http/errors.js';

/**
 * Serial numbers and batches on every movement (ninth round; ADR-0013).
 *
 * A request moving a tracked item may name the lots it moves — a serial
 * number one unit at a time, a batch with a quantity — by id or by code. Stock
 * arriving needs its codes (a new serial or batch is made on the spot); stock
 * leaving, when the request names none, takes the batch expiring first, or the
 * oldest serial, never an expired batch unless asked. An untracked item moves
 * as it always did.
 */

export const lotSpecSchema = z
  .object({
    lotId: z.uuid().optional(),
    /** A serial number or batch code as printed; new ones are made where stock arrives. */
    code: z.string().trim().min(1).max(100).optional(),
    /** A new batch's expiry day. */
    expiresOn: z.iso.date().optional(),
    /** One for a serial number. */
    quantity: positiveQuantitySchema.default('1'),
  })
  .refine((spec) => spec.lotId !== undefined || spec.code !== undefined, {
    message: 'Name the serial or batch by id or code.',
    path: ['code'],
  });
export type LotSpec = z.infer<typeof lotSpecSchema>;

/** Up to 500 lots on one line: a pallet of serialised units. */
export const lotSpecsSchema = z.array(lotSpecSchema).max(500);

export interface LotAllocation {
  lotId: string | null;
  quantity: string;
}

function refuse(
  code: string,
  message: string,
  field: string,
  params?: Record<string, string>,
): never {
  throw unprocessable(code, message, [
    { field, code, message, ...(params === undefined ? {} : { params }) },
  ]);
}

function total(quantities: readonly string[]): string {
  return quantities.reduce((sum, quantity) => addDecimals(sum, quantity), '0');
}

function checkSerialOnes(item: Item, specs: readonly LotSpec[], field: string): void {
  if (
    item.tracking === 'serial' &&
    specs.some((spec) => compareDecimals(spec.quantity, '1') !== 0)
  ) {
    refuse('serial_single_unit', 'A serial number is one unit.', field);
  }
}

function checkTotal(specs: readonly LotSpec[], quantity: string, field: string): void {
  const sum = total(specs.map((spec) => spec.quantity));
  if (compareDecimals(sum, quantity) !== 0) {
    refuse(
      'lots_quantity_mismatch',
      'The serial numbers or batches do not add up to the quantity.',
      field,
      {
        quantity,
        lots: sum,
      },
    );
  }
}

/**
 * Lots for stock leaving a location. Named ones are checked (this item's, a
 * serial one at a time, adding up, an expired batch only when allowed);
 * otherwise the earliest expiry first, then the oldest.
 */
export async function lotsLeaving(
  tx: TenantTransaction,
  item: Item,
  locationId: string,
  quantity: string,
  specs: readonly LotSpec[] | undefined,
  options: {
    today: string;
    allowExpired?: boolean | undefined;
    /** Why an expired batch is used anyway; required when one is. */
    reason?: string | null | undefined;
    field?: string;
  },
): Promise<LotAllocation[]> {
  const field = options.field ?? 'body.lots';
  const expired = (lot: StockLot) => lot.expiresOn !== null && lot.expiresOn < options.today;
  const needReason = () => {
    if ((options.reason ?? '').trim() === '') {
      refuse('reason_required', 'Say why an expired batch is used.', 'body.reason');
    }
  };
  if (item.tracking === 'none') {
    if (specs !== undefined && specs.length > 0) {
      refuse('item_not_tracked', 'This item has no serial numbers or batches.', field);
    }
    return [{ lotId: null, quantity }];
  }
  if (specs !== undefined && specs.length > 0) {
    checkSerialOnes(item, specs, field);
    checkTotal(specs, quantity, field);
    const named = await resolveNamed(tx, item, specs, field);
    for (const [index, lot] of named.entries()) {
      if (!expired(lot)) {
        continue;
      }
      if (options.allowExpired !== true) {
        refuse(
          'batch_expired',
          'This batch has expired. Confirm to use it anyway.',
          `${field}.${index}`,
          {
            code: lot.code,
            expiresOn: lot.expiresOn ?? '',
          },
        );
      }
      needReason();
    }
    return named.map((lot, index) => ({ lotId: lot.id, quantity: specs[index]!.quantity }));
  }
  if (item.tracking === 'serial' && !/^\d+(\.0+)?$/u.test(quantity)) {
    refuse('serial_single_unit', 'Serial numbers move in whole units.', 'body.quantity');
  }
  const allocations: LotAllocation[] = [];
  let left = quantity;
  for (const lot of await tx.inventoryLots.available(item.id, locationId)) {
    if (compareDecimals(left, '0') <= 0) {
      break;
    }
    if (expired(lot)) {
      if (options.allowExpired !== true) {
        continue;
      }
      needReason();
    }
    const take = compareDecimals(lot.onHand, left) < 0 ? lot.onHand : left;
    allocations.push({ lotId: lot.id, quantity: take });
    left = addDecimals(left, `-${take}`);
  }
  if (compareDecimals(left, '0') > 0) {
    throw conflict(
      'insufficient_stock',
      'There is not enough of this item, in serial numbers or batches that can be used, there.',
    );
  }
  return allocations;
}

async function resolveNamed(
  tx: TenantTransaction,
  item: Item,
  specs: readonly LotSpec[],
  field: string,
): Promise<StockLot[]> {
  const byId = new Map(
    (await tx.inventoryLots.find(specs.flatMap((spec) => spec.lotId ?? []))).map((lot) => [
      lot.id,
      lot,
    ]),
  );
  const byCode = await tx.inventoryLots.byCodes(
    item.id,
    specs.flatMap((spec) =>
      spec.lotId === undefined && spec.code !== undefined ? [spec.code] : [],
    ),
  );
  const seen = new Set<string>();
  return specs.map((spec, index) => {
    const lot = spec.lotId === undefined ? byCode.get(spec.code!) : byId.get(spec.lotId);
    if (lot?.itemId !== item.id) {
      throw new ApiError(
        404,
        'lot_not_found',
        'This serial number or batch is not one of this item’s.',
        [
          {
            field: `${field}.${index}`,
            code: 'lot_not_found',
            message: 'Not one of this item’s.',
            params: { code: spec.code ?? spec.lotId ?? '' },
          },
        ],
      );
    }
    if (seen.has(lot.id)) {
      refuse('lot_repeated', 'Each serial number or batch is named once.', `${field}.${index}`);
    }
    seen.add(lot.id);
    return lot;
  });
}

/**
 * Whether a location holds each named lot in the quantity asked, locking the
 * lot balances until the transaction ends: a use decides between posting and a
 * conflict on this.
 */
export async function lotsHeld(
  tx: TenantTransaction,
  locationId: string,
  allocations: readonly LotAllocation[],
): Promise<boolean> {
  for (const allocation of allocations) {
    if (allocation.lotId === null) {
      continue;
    }
    const held = await tx.inventoryLots.lockBalance(allocation.lotId, locationId);
    if (compareDecimals(held, allocation.quantity) < 0) {
      return false;
    }
  }
  return true;
}

/**
 * Lots for stock arriving: each named by code (a serial number one unit at a
 * time, a batch with its expiry), made if new. A tracked item's arriving stock
 * must name them, unless `autoBatchCode` gives a batch's code.
 */
export async function lotsArriving(
  tx: TenantTransaction,
  item: Item,
  quantity: string,
  specs: readonly LotSpec[] | undefined,
  options: { actorId: UserId | string; field?: string; autoBatchCode?: string },
): Promise<LotAllocation[]> {
  const field = options.field ?? 'body.lots';
  if (item.tracking === 'none') {
    if (specs !== undefined && specs.length > 0) {
      refuse('item_not_tracked', 'This item has no serial numbers or batches.', field);
    }
    return [{ lotId: null, quantity }];
  }
  if (specs === undefined || specs.length === 0) {
    if (item.tracking === 'batch' && options.autoBatchCode !== undefined) {
      const lot = await lotForCode(
        tx,
        item.id,
        'batch',
        options.autoBatchCode,
        null,
        options.actorId,
        field,
      );
      return [{ lotId: lot.id, quantity }];
    }
    refuse(
      'lots_required',
      item.tracking === 'serial'
        ? 'Give the serial number of each unit arriving.'
        : 'Give the batch code of what is arriving.',
      field,
    );
  }
  checkSerialOnes(item, specs, field);
  checkTotal(specs, quantity, field);
  const allocations: LotAllocation[] = [];
  const seen = new Set<string>();
  for (const [index, spec] of specs.entries()) {
    let lot: StockLot | undefined;
    if (spec.lotId !== undefined) {
      [lot] = await tx.inventoryLots.find([spec.lotId]);
      if (lot?.itemId !== item.id) {
        throw new ApiError(
          404,
          'lot_not_found',
          'This serial number or batch is not one of this item’s.',
        );
      }
    } else {
      lot = await lotForCode(
        tx,
        item.id,
        item.tracking,
        spec.code!,
        spec.expiresOn ?? null,
        options.actorId,
        `${field}.${index}`,
      );
    }
    if (seen.has(lot.id)) {
      refuse('lot_repeated', 'Each serial number or batch is named once.', `${field}.${index}`);
    }
    seen.add(lot.id);
    allocations.push({ lotId: lot.id, quantity: spec.quantity });
  }
  return allocations;
}

/**
 * The item's serial number or batch under this code, made if new; refused
 * when the code belongs to one of the other kind, from before the item's
 * tracking changed.
 */
export async function lotForCode(
  tx: TenantTransaction,
  itemId: string,
  kind: 'serial' | 'batch',
  code: string,
  expiresOn: string | null,
  actorId: UserId | string,
  field: string,
): Promise<StockLot> {
  const lot = await tx.inventoryLots.getOrCreate({ itemId, kind, code, expiresOn }, actorId);
  if (lot.kind !== kind) {
    refuse(
      'lot_code_taken',
      'This code was used for this item before, as a serial number or batch of the other kind.',
      field,
      { code: lot.code },
    );
  }
  return lot;
}

/**
 * A movement split by lot: one row per lot, each with its own source key, so
 * the posting stays written once. Signs follow the base movement.
 */
export function byLot(base: MovementInput, allocations: readonly LotAllocation[]): MovementInput[] {
  const negative = base.quantity.startsWith('-');
  return allocations.map((allocation) => ({
    ...base,
    quantity: negative ? `-${allocation.quantity}` : allocation.quantity,
    lotId: allocation.lotId,
    sourceKey:
      allocation.lotId === null ? base.sourceKey : `${base.sourceKey}:lot:${allocation.lotId}`,
  }));
}

/** The lots a movement out moved, for the movement in on the other side of a transfer. */
export function mirror(allocations: readonly LotAllocation[]): LotAllocation[] {
  return allocations.map((allocation) => ({ ...allocation }));
}
