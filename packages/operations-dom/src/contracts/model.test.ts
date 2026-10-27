import { describe, expect, it } from 'vitest';
import {
  moneyValid,
  scopeBody,
  scopeDraft,
  scopeEmpty,
  termReversed,
  wholeNumber,
} from './model.js';

const A = { id: '00000000-0000-4000-8000-000000000001', name: 'Block A' };

describe('contract drafts', () => {
  it('reads whole numbers, empty as none', () => {
    expect(wholeNumber('', 0, 10)).toBeNull();
    expect(wholeNumber('4', 0, 10)).toBe(4);
    expect(wholeNumber('11', 0, 10)).toBeUndefined();
    expect(wholeNumber('2.5', 0, 10)).toBeUndefined();
  });

  it('sends null for "all", and refuses "only these" with none chosen', () => {
    expect(scopeBody(scopeDraft(null))).toBeNull();
    expect(scopeBody(scopeDraft([A]))).toEqual([A.id]);
    expect(scopeEmpty({ all: false, ids: [] })).toBe(true);
    expect(scopeEmpty({ all: true, ids: [] })).toBe(false);
  });

  it('takes an amount with at most two decimals', () => {
    expect(moneyValid('12000')).toBe(true);
    expect(moneyValid('12000.50')).toBe(true);
    expect(moneyValid('12,000')).toBe(false);
    expect(moneyValid('1.234')).toBe(false);
  });

  it('judges a term only once both ends are chosen', () => {
    expect(termReversed('2026-02-01', '2026-01-31')).toBe(true);
    expect(termReversed('2026-02-01', '2026-02-01')).toBe(false);
    expect(termReversed('2026-02-01', '')).toBe(false);
  });
});
