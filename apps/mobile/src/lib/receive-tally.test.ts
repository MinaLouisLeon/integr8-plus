import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  compareDecimals,
  isDecimal,
  isPositiveDecimal,
  normaliseDecimal,
  subtractDecimals,
} from './decimal';
import { outstanding, receiptLines, scan, setCount, type TallyLine } from './receive-tally';
import { addItem, fromProposal, removeItem, requestLines, setQuantity } from './refill-lines';

/**
 * Counting a delivery by scanning (ADR-0012), and the van refill request's
 * lines: exact decimal arithmetic, never a JavaScript number.
 */

describe('decimal strings', () => {
  it('adds and subtracts exactly, to four places', () => {
    expect(addDecimals('0.1', '0.2')).toBe('0.3');
    expect(addDecimals('2.5', '1')).toBe('3.5');
    expect(addDecimals('9999999999999999.9999', '0.0001')).toBe('10000000000000000');
    expect(subtractDecimals('10', '2.25')).toBe('7.75');
    expect(subtractDecimals('1', '3')).toBe('0');
    expect(compareDecimals('2.50', '2.5')).toBe(0);
    expect(compareDecimals('10', '9.9999')).toBe(1);
    expect(normaliseDecimal(' 007.500 ')).toBe('7.5');
  });

  it('takes what the API takes', () => {
    expect(isPositiveDecimal('0')).toBe(false);
    expect(isPositiveDecimal('0.0001')).toBe(true);
    expect(isPositiveDecimal('1.23456')).toBe(false);
    expect(isPositiveDecimal('1,5')).toBe(false);
    expect(isDecimal('0')).toBe(true);
    expect(isDecimal('-1')).toBe(false);
  });
});

const VALVE = { id: 'item-valve', name: 'Ball valve' };
const TAPE = { id: 'item-tape', name: 'PTFE tape' };
const lines: TallyLine[] = [
  { id: 'line-1', item: VALVE, quantityOrdered: '3', quantityReceived: '1' },
  { id: 'line-2', item: TAPE, quantityOrdered: '2.5', quantityReceived: '0' },
  // The same item again, on a later line.
  { id: 'line-3', item: VALVE, quantityOrdered: '1', quantityReceived: '0' },
];

describe('scanning a delivery against an order', () => {
  it('adds one to the item’s line per scan, and fills a second line of it after the first', () => {
    let tally = {};
    const outcomes: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = scan(lines, tally, VALVE.id);
      outcomes.push(
        result.outcome === 'not_on_order' ? result.outcome : `${result.outcome}:${result.lineId}`,
      );
      tally = result.tally;
    }
    // Line 1 has 2 left to receive, line 3 has 1: the fourth scan is one too many.
    expect(outcomes).toEqual(['added:line-1', 'added:line-1', 'added:line-3', 'over:line-1']);
    expect(tally).toEqual({ 'line-1': '2', 'line-3': '1' });
    expect(receiptLines(lines, tally)).toEqual([
      { orderLineId: 'line-1', quantity: '2' },
      { orderLineId: 'line-3', quantity: '1' },
    ]);
  });

  it('says when an item is not on the order, and counts nothing for it', () => {
    const result = scan(lines, { 'line-2': '1' }, 'item-elsewhere');
    expect(result).toEqual({ outcome: 'not_on_order', tally: { 'line-2': '1' } });
  });

  it('never counts past what is left of a fractional line', () => {
    let tally = {};
    const kinds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = scan(lines, tally, TAPE.id);
      kinds.push(result.outcome);
      tally = result.tally;
    }
    // 2.5 left: two scans fit, the third would be 3.
    expect(kinds).toEqual(['added', 'added', 'over']);
    expect(outstanding(lines[1]!)).toBe('2.5');
  });

  it('takes a typed quantity up to what is left, and clears a line with zero', () => {
    const typed = setCount(lines, {}, 'line-2', '2.5');
    expect(typed).toEqual({ outcome: 'set', tally: { 'line-2': '2.5' } });
    expect(setCount(lines, {}, 'line-2', '2.5001')).toEqual({
      outcome: 'over',
      outstanding: '2.5',
    });
    expect(setCount(lines, {}, 'line-2', 'two')).toEqual({ outcome: 'invalid' });
    expect(setCount(lines, {}, 'line-9', '1')).toEqual({ outcome: 'invalid' });
    expect(setCount(lines, { 'line-2': '2.5', 'line-1': '1' }, 'line-2', '0')).toEqual({
      outcome: 'set',
      tally: { 'line-1': '1' },
    });
    expect(receiptLines(lines, {})).toEqual([]);
  });

  it('leaves a line received in full with nothing to count', () => {
    const full: TallyLine[] = [
      { id: 'line-1', item: VALVE, quantityOrdered: '2', quantityReceived: '2' },
    ];
    expect(scan(full, {}, VALVE.id)).toMatchObject({ outcome: 'over', lineId: 'line-1' });
    expect(outstanding({ ...full[0]!, quantityReceived: '3' })).toBe('0');
  });
});

describe('the lines of a van refill request', () => {
  const valve = { id: 'item-valve', sku: 'VAL', name: 'Ball valve', unit: 'each' };
  const tape = { id: 'item-tape', sku: 'PTF', name: 'PTFE tape', unit: 'roll' };

  it('starts from the van’s proposal, and sends what the engineer made of it', () => {
    let request = fromProposal([
      { item: valve, onHand: '1', minimum: '5', requested: '0', quantity: '4' },
    ]);
    request = addItem(request, tape);
    // An item already on the request keeps its line: the server takes each once.
    request = addItem(request, valve);
    request = setQuantity(request, tape.id, ' 2.50 ');
    expect(requestLines(request)).toEqual({
      ok: true,
      lines: [
        { itemId: valve.id, quantity: '4' },
        { itemId: tape.id, quantity: '2.5' },
      ],
    });
    expect(requestLines(removeItem(removeItem(request, valve.id), tape.id))).toEqual({
      ok: false,
      reason: 'empty',
      itemIds: [],
    });
  });

  it('names each line whose quantity cannot be sent', () => {
    const request = setQuantity(addItem(addItem([], valve), tape), valve.id, '0');
    expect(requestLines(request)).toEqual({
      ok: false,
      reason: 'invalid_quantity',
      itemIds: [valve.id],
    });
  });
});
