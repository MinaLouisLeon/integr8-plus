import type { VanLot } from '@integr8/offline';
import { compareDecimals, isPositiveDecimal } from './decimal';

/**
 * Choosing the serial numbers or batches of a part used, from the van's own
 * list, offline (ADR-0013). A serial-numbered part names each unit fitted —
 * picked from the list or scanned — and its quantity is how many were
 * chosen; a batched part may name one batch, the earliest expiry proposed,
 * or leave it to the server. An expired batch needs the engineer to confirm
 * it and say why in the note.
 *
 * Pure, so the rules are tested without a phone.
 */

export type Tracking = 'none' | 'serial' | 'batch';

/** The phone's calendar day, as `YYYY-MM-DD`: what an expiry is read against. */
export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function isExpired(lot: Pick<VanLot, 'expiresOn'>, today: string): boolean {
  return lot.expiresOn !== null && lot.expiresOn < today;
}

/** The van's serial numbers or batches probably still there: none this phone has used up. */
export function lotsLeft(lots: readonly VanLot[]): VanLot[] {
  return lots.filter((lot) => isPositiveDecimal(lot.forecast));
}

/**
 * The batch proposed: the first still in the van that has not expired, in the
 * van's order — earliest expiry first, as the server would take it.
 */
export function proposedBatch(lots: readonly VanLot[], today: string): string | null {
  return lotsLeft(lots).find((lot) => !isExpired(lot, today))?.lotId ?? null;
}

/** A serial number chosen, or chosen no longer. */
export function toggleSerial(chosen: readonly string[], lotId: string): string[] {
  return chosen.includes(lotId) ? chosen.filter((id) => id !== lotId) : [...chosen, lotId];
}

/**
 * The van's serial number a scanned barcode names: the same code, spaces
 * around it and capitals aside. Only one still in the van is found.
 */
export function serialByScan(lots: readonly VanLot[], scanned: string): VanLot | undefined {
  const code = scanned.trim().toLowerCase();
  if (code === '') {
    return undefined;
  }
  return lotsLeft(lots).find((lot) => lot.code.trim().toLowerCase() === code);
}

/** What the engineer chose for a part. */
export interface PartPick {
  tracking: Tracking;
  /** The quantity typed; for a serial-numbered part, how many were chosen instead. */
  quantity: string;
  /** Serial numbers chosen, by lot. */
  serials: readonly string[];
  /** The batch chosen, or `null` for the one expiring first. */
  batchId: string | null;
  /** An expired batch confirmed; the note says why. */
  expiredConfirmed: boolean;
  note: string;
}

export type PickProblem =
  'quantity_invalid' | 'serial_required' | 'expired_unconfirmed' | 'note_required';

/** The batch chosen when it has expired, for the warning. */
export function expiredChoice(
  pick: PartPick,
  lots: readonly VanLot[],
  today: string,
): VanLot | undefined {
  if (pick.tracking !== 'batch' || pick.batchId === null) {
    return undefined;
  }
  const lot = lots.find((candidate) => candidate.lotId === pick.batchId);
  return lot !== undefined && isExpired(lot, today) ? lot : undefined;
}

/** What stops the use from being recorded, if anything. */
export function pickProblem(
  pick: PartPick,
  lots: readonly VanLot[],
  today: string,
): PickProblem | null {
  if (pick.tracking === 'serial') {
    return pick.serials.length === 0 ? 'serial_required' : null;
  }
  if (!isPositiveDecimal(pick.quantity)) {
    return 'quantity_invalid';
  }
  if (expiredChoice(pick, lots, today) !== undefined) {
    if (!pick.expiredConfirmed) {
      return 'expired_unconfirmed';
    }
    if (pick.note.trim() === '') {
      return 'note_required';
    }
  }
  return null;
}

/**
 * The use as `recordMaterial` takes it: the quantity — the serial numbers'
 * count for a serial-numbered part — the lots named, and an expired batch
 * confirmed.
 */
export function partUse(
  pick: PartPick,
  lots: readonly VanLot[],
  today: string,
): {
  quantity: string;
  lots?: { lotId: string; quantity: string }[];
  allowExpired?: boolean;
} {
  if (pick.tracking === 'serial') {
    return {
      quantity: String(pick.serials.length),
      lots: pick.serials.map((lotId) => ({ lotId, quantity: '1' })),
    };
  }
  const quantity = pick.quantity.trim();
  if (pick.tracking === 'none' || pick.batchId === null) {
    return { quantity };
  }
  return {
    quantity,
    lots: [{ lotId: pick.batchId, quantity }],
    ...(expiredChoice(pick, lots, today) === undefined ? {} : { allowExpired: true }),
  };
}

/** Whether a batch probably holds less than is being used: said, not refused — the office settles it. */
export function batchShort(pick: PartPick, lots: readonly VanLot[]): boolean {
  if (pick.tracking !== 'batch' || pick.batchId === null || !isPositiveDecimal(pick.quantity)) {
    return false;
  }
  const lot = lots.find((candidate) => candidate.lotId === pick.batchId);
  return lot !== undefined && compareDecimals(lot.forecast, pick.quantity.trim()) < 0;
}
