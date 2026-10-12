import { describe, expect, it } from 'vitest';
import {
  componentNeeds,
  disassemblyUnitCosts,
  formatAssemblyReference,
  multiplyDecimal,
  parseAssemblyReference,
  rolledUpUnitCost,
  wouldContainItself,
} from './manufacturing.js';
import { toUnits } from './ledger.js';

describe('assembly references', () => {
  it('read and write AO-000123', () => {
    expect(formatAssemblyReference(123)).toBe('AO-000123');
    expect(parseAssemblyReference('ao-123')).toBe(123);
    expect(parseAssemblyReference('AO-000007')).toBe(7);
    expect(parseAssemblyReference('PO-1')).toBeUndefined();
  });
});

describe('a bill of materials', () => {
  const pumpSet = [
    { itemId: 'pump', quantity: '1' },
    { itemId: 'hose', quantity: '2.5' },
    { itemId: 'clip', quantity: '4' },
  ];

  it('says what a run needs, exactly', () => {
    expect(componentNeeds(pumpSet, '3')).toEqual([
      { itemId: 'pump', quantity: '3' },
      { itemId: 'hose', quantity: '7.5' },
      { itemId: 'clip', quantity: '12' },
    ]);
    expect(multiplyDecimal('0.3333', '3')).toBe('0.9999');
  });

  it('costs a unit as its parts now, plus labour and overhead', () => {
    const costs = new Map([
      ['pump', '1200'],
      ['hose', '35.5'],
      ['clip', '2.25'],
    ]);
    // 1200 + 88.75 + 9 + 50 + 12.5
    expect(rolledUpUnitCost(pumpSet, costs, '50', '12.5')).toBe('1360.25');
  });

  it('shares a unit’s value among its parts when taken apart, losing nothing', () => {
    const needs = [
      { itemId: 'a', quantity: '3' },
      { itemId: 'b', quantity: '3' },
    ];
    const costs = new Map([
      ['a', '1'],
      ['b', '2'],
    ]);
    const unitCosts = disassemblyUnitCosts(needs, costs, '3', '10');
    const value = needs.reduce(
      (sum, need) => sum + toUnits(multiplyDecimal(need.quantity, unitCosts.get(need.itemId)!)),
      0n,
    );
    // 30 of value, shared one third to two thirds.
    expect(value).toBe(toUnits('30'));
    expect(unitCosts.get('b')).toBe('6.6666');
  });

  it('never contains itself, however deep', () => {
    const bills = new Map([
      ['kit', ['panel', 'cable']],
      ['panel', ['breaker']],
    ]);
    expect(wouldContainItself('breaker', ['wire'], (item) => bills.get(item))).toBe(false);
    expect(wouldContainItself('breaker', ['kit'], (item) => bills.get(item))).toBe(true);
    expect(wouldContainItself('kit', ['kit'], (item) => bills.get(item))).toBe(true);
  });
});
