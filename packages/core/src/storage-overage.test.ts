import { describe, expect, it } from 'vitest';
import { monthBounds, monthlyOverage, utcMonthOf, previousMonth } from './storage-overage.js';

const GB = 1_000_000_000;

describe('months', () => {
  it('knows how long each month is, leap years included', () => {
    expect(monthBounds('2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30', days: 30 });
    expect(monthBounds('2026-02').days).toBe(28);
    expect(monthBounds('2028-02').days).toBe(29);
    expect(monthBounds('2026-12').last).toBe('2026-12-31');
  });

  it('refuses something that is not a month', () => {
    expect(() => monthBounds('2026-13')).toThrow(RangeError);
    expect(() => monthBounds('2026-1')).toThrow(RangeError);
  });

  it('steps back a month, across a year', () => {
    expect(previousMonth('2026-11')).toBe('2026-10');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-03')).toBe('2026-02');
  });

  it('reads the month of an instant in UTC', () => {
    expect(utcMonthOf(new Date('2026-11-30T23:30:00Z'))).toBe('2026-11');
    expect(utcMonthOf(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });
});

describe('a month of overage', () => {
  it('averages the daily overage over every day of the month: a GB-month', () => {
    // 10 GB over for 15 days of a 30-day month: 5 GB-months.
    const samples = Array.from({ length: 15 }, (_, index) => ({
      day: `2026-11-${String(index + 1).padStart(2, '0')}`,
      overageBytes: 10 * GB,
    }));
    expect(monthlyOverage(samples, '2026-11')).toEqual({
      month: '2026-11',
      daysInMonth: 30,
      daysOver: 15,
      peakBytes: 10 * GB,
      averageBytes: 5 * GB,
    });
  });

  it('ignores other months, days under the line and uncapped days', () => {
    const result = monthlyOverage(
      [
        { day: '2026-10-31', overageBytes: 50 * GB },
        { day: '2026-11-01', overageBytes: 0 },
        { day: '2026-11-02', overageBytes: null },
        { day: '2026-11-03', overageBytes: 3 * GB },
        { day: '2026-11-04', overageBytes: 6 * GB },
        { day: '2026-12-01', overageBytes: 50 * GB },
      ],
      '2026-11',
    );
    expect(result.daysOver).toBe(2);
    expect(result.peakBytes).toBe(6 * GB);
    expect(result.averageBytes).toBe((9 * GB) / 30);
  });

  it('is all zeros for a month without overage', () => {
    expect(monthlyOverage([], '2026-02')).toEqual({
      month: '2026-02',
      daysInMonth: 28,
      daysOver: 0,
      peakBytes: 0,
      averageBytes: 0,
    });
  });
});
