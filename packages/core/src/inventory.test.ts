import { describe, expect, it } from 'vitest';
import {
  compareDecimals,
  isZeroDecimal,
  MOVEMENT_KINDS,
  MOVEMENT_SIGNS,
  positiveQuantitySchema,
  purchaseOrderReceivable,
  quantitySchema,
} from './inventory.js';
import { can } from './permissions.js';
import { ROLES } from './roles.js';

describe('who may use inventory and purchasing (product decision, 2026-10-11)', () => {
  const holders = (permission: Parameters<typeof can>[1]) =>
    ROLES.filter((role) => can(role, permission));

  it('lets owners, admins, inventory managers and dispatchers run stock and draft purchases', () => {
    for (const permission of ['inventory.manage', 'inventory.move', 'purchasing.manage'] as const) {
      expect(holders(permission), permission).toEqual([
        'owner',
        'admin',
        'inventory_manager',
        'dispatcher',
      ]);
    }
  });

  it('leaves approving a purchase to owners and admins', () => {
    expect(holders('purchasing.approve')).toEqual(['owner', 'admin']);
  });

  it('lets engineers see stock and record parts used, and nothing else', () => {
    expect(holders('inventory.read')).toEqual([
      'owner',
      'admin',
      'inventory_manager',
      'dispatcher',
      'engineer',
      'viewer',
    ]);
    expect(holders('inventory.consume')).toEqual([
      'owner',
      'admin',
      'inventory_manager',
      'dispatcher',
      'engineer',
    ]);
    expect(holders('purchasing.read')).toEqual([
      'owner',
      'admin',
      'inventory_manager',
      'dispatcher',
      'viewer',
    ]);
  });
});

describe('quantities', () => {
  it('accepts decimal strings only, and positive ones where it must', () => {
    expect(quantitySchema.safeParse('2.5').success).toBe(true);
    expect(quantitySchema.safeParse('0').success).toBe(true);
    expect(quantitySchema.safeParse('-1').success).toBe(false);
    expect(quantitySchema.safeParse('1.23456').success).toBe(false);
    expect(positiveQuantitySchema.safeParse('0.000').success).toBe(false);
    expect(positiveQuantitySchema.safeParse('0.0001').success).toBe(true);
  });

  it('compares decimals exactly, without numbers', () => {
    expect(compareDecimals('10', '9.9999')).toBe(1);
    expect(compareDecimals('0.30', '0.3')).toBe(0);
    expect(compareDecimals('9999999999999999.9998', '9999999999999999.9999')).toBe(-1);
    expect(compareDecimals('007', '7.0')).toBe(0);
    expect(isZeroDecimal('0.0000')).toBe(true);
    expect(isZeroDecimal('0.01')).toBe(false);
  });
});

describe('the ledger', () => {
  it('gives every movement kind a sign', () => {
    expect(MOVEMENT_KINDS).toHaveLength(9);
    expect(MOVEMENT_SIGNS.transfer_out + MOVEMENT_SIGNS.transfer_in).toBe(0);
    expect(MOVEMENT_SIGNS.consumption).toBe(-1);
  });

  it('receives only against approved orders', () => {
    expect(purchaseOrderReceivable('draft')).toBe(false);
    expect(purchaseOrderReceivable('approved')).toBe(true);
    expect(purchaseOrderReceivable('partially_received')).toBe(true);
    expect(purchaseOrderReceivable('received')).toBe(false);
  });
});
