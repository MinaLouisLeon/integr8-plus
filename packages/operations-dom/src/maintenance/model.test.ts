import { describe, expect, it } from 'vitest';
import type { MaintenanceItem } from '../api.js';
import { choices, filterItems, formatMonth, groupByMonth, NO_FILTERS } from './model.js';

const A = { id: '00000000-0000-4000-8000-000000000001', name: 'Zeta' };
const B = { id: '00000000-0000-4000-8000-000000000002', name: 'Alpha' };

function item(key: string, dueOn: string, customer = A, assetName = 'Boiler'): MaintenanceItem {
  return {
    key,
    plan: { id: key, title: 'Service' },
    asset: { id: key, name: assetName, reference: 'AS-000001' },
    customer,
    site: customer,
    jobType: { id: 'type', name: 'Service' },
    dueOn,
    standing: 'upcoming',
    skipReason: null,
    workOrder: null,
  };
}

describe('maintenance lists', () => {
  it('groups by month, earliest first, then by asset', () => {
    const groups = groupByMonth(
      [
        item('1', '2026-11-02'),
        item('2', '2026-10-15', A, 'Pump'),
        item('3', '2026-10-15', A, 'Chiller'),
        item('4', '2027-01-01'),
      ],
      'en',
    );
    expect(groups.map((group) => group.month)).toEqual(['2026-10', '2026-11', '2027-01']);
    expect(groups[0]!.items.map((entry) => entry.key)).toEqual(['3', '2']);
    expect(formatMonth('2026-10', 'en')).toBe('October 2026');
  });

  it('filters by customer, and offers each customer once, by name', () => {
    const items = [
      item('1', '2026-10-01', A),
      item('2', '2026-10-02', B),
      item('3', '2026-10-03', A),
    ];
    expect(
      filterItems(items, { ...NO_FILTERS, customerId: B.id }).map((entry) => entry.key),
    ).toEqual(['2']);
    expect(
      choices(
        items.map((entry) => entry.customer),
        'en',
      ),
    ).toEqual([B, A]);
  });
});
