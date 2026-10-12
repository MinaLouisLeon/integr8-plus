import { z } from 'zod';

/**
 * The inventory and purchasing vocabulary (CRM/ERP plan, phases E1 and E2),
 * shared by every client and the API. Each list is also a check constraint in
 * the database, and the schema-invariant suite compares the two.
 *
 * Quantities, like money, travel as decimal strings and are never JavaScript
 * numbers: a metre of cable is 0.5, and 0.1 + 0.2 must stay 0.3.
 */

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * `stock_item`: counted, lives in locations, moves through the ledger.
 * `non_stock_item`: bought or used, never counted (the one-off part from a
 * merchant). `service`: work, never stock.
 */
export const ITEM_KINDS = ['stock_item', 'non_stock_item', 'service'] as const;
export const itemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof itemKindSchema>;

/**
 * How a stock item's units are told apart (ADR-0013): not at all, one serial
 * number per unit, or a batch code (with an optional expiry) per lot.
 */
export const ITEM_TRACKINGS = ['none', 'serial', 'batch'] as const;
export const itemTrackingSchema = z.enum(ITEM_TRACKINGS);
export type ItemTracking = z.infer<typeof itemTrackingSchema>;

/** Units of measure every company has. Screens translate them (`inventory.unit.<code>`). */
export const UNITS = [
  'each',
  'pair',
  'set',
  'box',
  'pack',
  'roll',
  'm',
  'm2',
  'm3',
  'l',
  'kg',
  'g',
  'hour',
] as const;
export const unitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof unitSchema>;

// ---------------------------------------------------------------------------
// Locations and the ledger
// ---------------------------------------------------------------------------

/** Where stock is: a warehouse, an engineer's van, or a customer's site. */
export const LOCATION_KINDS = ['warehouse', 'van', 'site'] as const;
export const locationKindSchema = z.enum(LOCATION_KINDS);
export type LocationKind = z.infer<typeof locationKindSchema>;

/**
 * Whose stock a location holds (ADR-0012): ours, counted and valued, or — at
 * a customer's site only — the customer's, a record that is never valued,
 * planned from or posted to the ledger.
 */
export const LOCATION_OWNERSHIPS = ['ours', 'customer'] as const;
export const locationOwnershipSchema = z.enum(LOCATION_OWNERSHIPS);
export type LocationOwnership = z.infer<typeof locationOwnershipSchema>;

/**
 * Every kind of movement in the ledger, and the sign its quantity carries:
 * `+1` adds stock where it happens, `-1` takes it away, `0` either (a
 * correction can go both ways).
 */
export const MOVEMENT_SIGNS = {
  receipt: 1,
  issue: -1,
  transfer_out: -1,
  transfer_in: 1,
  adjustment: 0,
  count_adjustment: 0,
  consumption: -1,
  consumption_return: 1,
  return_to_supplier: -1,
  // Assembly and disassembly orders (ADR-0011): what goes in, and what comes out.
  assembly_consumption: -1,
  assembly_output: 1,
} as const;
export type MovementKind = keyof typeof MOVEMENT_SIGNS;
export const MOVEMENT_KINDS = Object.keys(MOVEMENT_SIGNS) as MovementKind[];
export const movementKindSchema = z.enum(MOVEMENT_KINDS as [MovementKind, ...MovementKind[]]);

/** What a person may post by hand; the rest come from receipts, counts and jobs. */
export const MANUAL_MOVEMENTS = ['receipt', 'issue', 'transfer', 'adjustment'] as const;
export type ManualMovement = (typeof MANUAL_MOVEMENTS)[number];

export const STOCK_COUNT_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export const stockCountStatusSchema = z.enum(STOCK_COUNT_STATUSES);
export type StockCountStatus = z.infer<typeof stockCountStatusSchema>;

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

const DECIMAL = /^\d{1,16}(\.\d{1,4})?$/u;

/** A quantity of zero or more, as a decimal string with up to four places. */
export const quantitySchema = z
  .string()
  .trim()
  .regex(DECIMAL, 'Use digits with up to four decimal places, such as 2.5');

/** A quantity greater than zero. */
export const positiveQuantitySchema = quantitySchema.refine(
  (value) => /[1-9]/u.test(value),
  'Use a quantity greater than zero',
);

/**
 * Compares two non-negative decimal strings exactly, without converting
 * either to a number: -1, 0 or 1.
 */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const [aWhole = '0', aFraction = ''] = a.split('.');
  const [bWhole = '0', bFraction = ''] = b.split('.');
  const wholeA = aWhole.replace(/^0+(?=\d)/u, '');
  const wholeB = bWhole.replace(/^0+(?=\d)/u, '');
  if (wholeA.length !== wholeB.length) {
    return wholeA.length < wholeB.length ? -1 : 1;
  }
  const width = Math.max(aFraction.length, bFraction.length);
  const left = wholeA + aFraction.padEnd(width, '0');
  const right = wholeB + bFraction.padEnd(width, '0');
  return left === right ? 0 : left < right ? -1 : 1;
}

/** True for "0", "0.0", "0000.00" and the like. */
export function isZeroDecimal(value: string): boolean {
  return !/[1-9]/u.test(value);
}

// ---------------------------------------------------------------------------
// Purchasing (phase E2)
// ---------------------------------------------------------------------------

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'approved',
  'partially_received',
  'received',
  'cancelled',
] as const;
export const purchaseOrderStatusSchema = z.enum(PURCHASE_ORDER_STATUSES);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

export const SUPPLIER_STATUSES = ['active', 'inactive'] as const;
export const supplierStatusSchema = z.enum(SUPPLIER_STATUSES);
export type SupplierStatus = z.infer<typeof supplierStatusSchema>;

/** Goods can be received only against an order in these states. */
export function purchaseOrderReceivable(status: PurchaseOrderStatus): boolean {
  return status === 'approved' || status === 'partially_received';
}

/** A tax rate in basis points: 1400 is 14 %. Whole numbers, so nothing rounds. */
export const taxRateSchema = z.number().int().min(0).max(10_000);

// ---------------------------------------------------------------------------
// Parts used on jobs (phase E2)
// ---------------------------------------------------------------------------

/**
 * `posted`: the part came out of stock (or was a non-stock item or service).
 * `conflict`: the van did not hold enough when it reached the server, so
 * nothing moved; somebody has to resolve it (ADR-0005). `cancelled`: dropped.
 */
export const MATERIAL_STATUSES = ['posted', 'conflict', 'cancelled'] as const;
export const materialStatusSchema = z.enum(MATERIAL_STATUSES);
export type MaterialStatus = z.infer<typeof materialStatusSchema>;
