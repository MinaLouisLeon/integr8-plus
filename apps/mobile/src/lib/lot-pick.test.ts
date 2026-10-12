import type { VanLot } from '@integr8/offline';
import { describe, expect, it } from 'vitest';
import {
  batchShort,
  expiredChoice,
  isExpired,
  localDay,
  lotsLeft,
  type PartPick,
  partUse,
  pickProblem,
  proposedBatch,
  serialByScan,
  toggleSerial,
} from './lot-pick';

/**
 * Picking a part's serial numbers or batches from the van, offline
 * (ADR-0013): what is proposed, what a scan finds, and what is sent.
 */

const TODAY = '2026-10-12';

const lot = (overrides: Partial<VanLot> & Pick<VanLot, 'lotId' | 'code'>): VanLot => ({
  kind: 'batch',
  expiresOn: null,
  onHand: '1',
  forecast: '1',
  ...overrides,
});

const serials = [
  lot({ lotId: 'sn-1', code: 'SN-0001', kind: 'serial' }),
  lot({ lotId: 'sn-2', code: 'SN-0002', kind: 'serial', forecast: '0' }),
  lot({ lotId: 'sn-3', code: 'sn-0003', kind: 'serial' }),
];
// Earliest expiry first, as the van's list comes.
const batches = [
  lot({ lotId: 'b-old', code: 'B-OLD', expiresOn: '2026-09-30', onHand: '4', forecast: '4' }),
  lot({ lotId: 'b-used', code: 'B-USED', expiresOn: '2026-11-01', onHand: '2', forecast: '0' }),
  lot({ lotId: 'b-next', code: 'B-NEXT', expiresOn: '2026-12-01', onHand: '5', forecast: '3.5' }),
  lot({ lotId: 'b-none', code: 'B-NONE', expiresOn: null, onHand: '9', forecast: '9' }),
];

const pick = (overrides: Partial<PartPick> = {}): PartPick => ({
  tracking: 'batch',
  quantity: '1',
  serials: [],
  batchId: null,
  expiredConfirmed: false,
  note: '',
  ...overrides,
});

describe('the van’s serial numbers and batches', () => {
  it('reads the day in the phone’s calendar and expiry against it', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
    expect(isExpired({ expiresOn: '2026-10-11' }, TODAY)).toBe(true);
    expect(isExpired({ expiresOn: TODAY }, TODAY)).toBe(false);
    expect(isExpired({ expiresOn: null }, TODAY)).toBe(false);
  });

  it('leaves out what this phone has already used up', () => {
    expect(lotsLeft(serials).map((row) => row.lotId)).toEqual(['sn-1', 'sn-3']);
  });

  it('proposes the batch expiring first that is left and has not expired', () => {
    expect(proposedBatch(batches, TODAY)).toBe('b-next');
    expect(proposedBatch(batches, '2026-12-02')).toBe('b-none');
    expect(proposedBatch([], TODAY)).toBeNull();
  });
});

describe('choosing serial numbers', () => {
  it('toggles a serial number in and out', () => {
    expect(toggleSerial([], 'sn-1')).toEqual(['sn-1']);
    expect(toggleSerial(['sn-1', 'sn-3'], 'sn-1')).toEqual(['sn-3']);
  });

  it('finds a scanned serial number in the van, capitals and spaces aside', () => {
    expect(serialByScan(serials, ' SN-0003\n')?.lotId).toBe('sn-3');
    expect(serialByScan(serials, 'sn-0001')?.lotId).toBe('sn-1');
    // Used up on this phone already, or never in the van: not found.
    expect(serialByScan(serials, 'SN-0002')).toBeUndefined();
    expect(serialByScan(serials, 'SN-9999')).toBeUndefined();
    expect(serialByScan(serials, '   ')).toBeUndefined();
  });

  it('needs at least one, and counts the units from those chosen', () => {
    const serial = pick({ tracking: 'serial', quantity: '' });
    expect(pickProblem(serial, serials, TODAY)).toBe('serial_required');
    const chosen = { ...serial, serials: ['sn-1', 'sn-3'] };
    expect(pickProblem(chosen, serials, TODAY)).toBeNull();
    expect(partUse(chosen, serials, TODAY)).toEqual({
      quantity: '2',
      lots: [
        { lotId: 'sn-1', quantity: '1' },
        { lotId: 'sn-3', quantity: '1' },
      ],
    });
  });
});

describe('choosing a batch', () => {
  it('may leave it to the server, which takes the one expiring first', () => {
    const any = pick({ quantity: '2.5' });
    expect(pickProblem(any, batches, TODAY)).toBeNull();
    expect(partUse(any, batches, TODAY)).toEqual({ quantity: '2.5' });
  });

  it('names the batch chosen with the whole quantity', () => {
    const named = pick({ quantity: '2.5', batchId: 'b-next' });
    expect(partUse(named, batches, TODAY)).toEqual({
      quantity: '2.5',
      lots: [{ lotId: 'b-next', quantity: '2.5' }],
    });
    expect(batchShort(named, batches)).toBe(false);
    expect(batchShort({ ...named, quantity: '3.5001' }, batches)).toBe(true);
  });

  it('asks for a confirmation and a note before using an expired batch', () => {
    const old = pick({ quantity: '1', batchId: 'b-old' });
    expect(expiredChoice(old, batches, TODAY)?.code).toBe('B-OLD');
    expect(pickProblem(old, batches, TODAY)).toBe('expired_unconfirmed');
    const confirmed = { ...old, expiredConfirmed: true };
    expect(pickProblem(confirmed, batches, TODAY)).toBe('note_required');
    const said = { ...confirmed, note: 'Customer asked for it' };
    expect(pickProblem(said, batches, TODAY)).toBeNull();
    expect(partUse(said, batches, TODAY)).toEqual({
      quantity: '1',
      lots: [{ lotId: 'b-old', quantity: '1' }],
      allowExpired: true,
    });
  });

  it('refuses a quantity the API would not take', () => {
    expect(pickProblem(pick({ quantity: '0' }), batches, TODAY)).toBe('quantity_invalid');
    expect(pickProblem(pick({ quantity: '1.23456' }), batches, TODAY)).toBe('quantity_invalid');
  });
});
