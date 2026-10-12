import { describe, expect, it } from 'vitest';
import {
  componentNeeds,
  disassemblyUnitCosts,
  formatAssemblyReference,
  multiplyDecimal,
  parseAssemblyReference,
  type PlanItem,
  planMaterials,
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

describe('planning', () => {
  const today = '2026-10-12';
  const items = new Map<string, PlanItem>([
    [
      'kit',
      {
        id: 'kit',
        kind: 'stock_item',
        leadTimeDays: 2,
        supplierId: null,
        supplierLeadTimeDays: null,
        bom: {
          id: 'bom-kit',
          components: [
            { itemId: 'pump', quantity: '1' },
            { itemId: 'hose', quantity: '2.5' },
          ],
        },
      },
    ],
    [
      'pump',
      {
        id: 'pump',
        kind: 'stock_item',
        leadTimeDays: null,
        supplierId: 'acme',
        supplierLeadTimeDays: 7,
        bom: null,
      },
    ],
    [
      'hose',
      {
        id: 'hose',
        kind: 'stock_item',
        leadTimeDays: 3,
        supplierId: 'hoses',
        supplierLeadTimeDays: 10,
        bom: null,
      },
    ],
  ]);

  it('builds what is sold from its parts, and buys the parts short, by when', () => {
    const plan = planMaterials({
      today,
      horizonEnd: '2026-11-30',
      items,
      onHand: new Map([
        ['kit', '1'],
        ['pump', '1'],
        ['hose', '4'],
      ]),
      reorderMinimum: new Map([['hose', '2']]),
      demands: [{ itemId: 'kit', quantity: '4', date: '2026-10-20', source: 'sales' }],
      supplies: [
        { itemId: 'pump', quantity: '1', date: '2026-10-15', source: 'purchase' },
        // After the horizon: not counted.
        { itemId: 'hose', quantity: '100', date: '2027-01-01', source: 'purchase' },
      ],
    });
    expect(plan.map((row) => [row.itemId, row.action, row.level, row.quantity])).toEqual([
      ['kit', 'build', 0, '3'],
      ['hose', 'buy', 1, '5.5'],
      ['pump', 'buy', 1, '1'],
    ]);
    const [kit, hose, pump] = plan;
    // Needed on the 20th, two days to build: started by the 18th.
    expect(kit).toMatchObject({ needBy: '2026-10-20', orderBy: '2026-10-18', bomId: 'bom-kit' });
    // Its parts are needed when the build starts; the hose's own lead time is three days.
    expect(hose).toMatchObject({
      needBy: '2026-10-18',
      orderBy: '2026-10-15',
      supplierId: 'hoses',
    });
    expect(hose?.basis).toEqual({ sales: '0', assembly: '0', parent: '7.5', lateByDays: 0 });
    // The pump's supplier takes a week: ordering on the 11th was needed, a day late.
    expect(pump).toMatchObject({ orderBy: today, leadTimeDays: 7 });
    expect(pump?.basis.lateByDays).toBe(1);
  });

  it('suggests nothing when stock and orders cover it', () => {
    expect(
      planMaterials({
        today,
        horizonEnd: '2026-11-30',
        items,
        onHand: new Map([['kit', '5']]),
        reorderMinimum: new Map(),
        demands: [{ itemId: 'kit', quantity: '4', date: today, source: 'sales' }],
        supplies: [],
      }),
    ).toEqual([]);
  });
});
