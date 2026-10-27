import { describe, expect, it } from 'vitest';
import { addMonths, isoWeekday, zonedInstant } from './calendar.js';
import {
  addInterval,
  advanceAfterCreating,
  calendarDue,
  creationDay,
  type DueCandidate,
  firstSequenceFrom,
  forecastDues,
  groupCandidates,
  initialNextDue,
  maintenanceStanding,
  nextAfterFinishing,
  windowDays,
  windowInstants,
  withinPlan,
} from './maintenance.js';

const quarterly = { count: 3, unit: 'month' } as const;

describe('calendar days', () => {
  it('keeps the day of the month, or the month’s last day when shorter', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('numbers weekdays from Monday', () => {
    expect(isoWeekday('2026-10-26')).toBe(1);
    expect(isoWeekday('2026-11-01')).toBe(7);
  });

  it('places a wall-clock time on either side of a daylight-saving change', () => {
    // London: BST until 25 October 2026, GMT after.
    expect(zonedInstant('2026-10-24', 9 * 60, 'Europe/London').toISOString()).toBe(
      '2026-10-24T08:00:00.000Z',
    );
    expect(zonedInstant('2026-10-26', 9 * 60, 'Europe/London').toISOString()).toBe(
      '2026-10-26T09:00:00.000Z',
    );
    expect(zonedInstant('2026-07-01', 0, 'Africa/Cairo').toISOString()).toBe(
      '2026-06-30T21:00:00.000Z',
    );
  });
});

describe('a calendar plan', () => {
  it('counts every date from the start, so a short month does not shift the rest', () => {
    const start = '2026-01-31';
    const monthly = { count: 1, unit: 'month' } as const;
    expect([0, 1, 2, 3].map((n) => calendarDue(start, monthly, n))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('makes quarterly jobs on the same days across a daylight-saving change', () => {
    const plan = {
      counting: 'calendar',
      interval: quarterly,
      startsOn: '2026-01-15',
      endsOn: null,
    } as const;
    let next = initialNextDue(plan, '2026-01-01', null);
    const made: { dueOn: string; dueFrom: string; dueBy: string }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { dueFrom, dueBy } = windowInstants(windowDays(next.nextDueOn!, 0, 0), 'Europe/London');
      made.push({
        dueOn: next.nextDueOn!,
        dueFrom: dueFrom.toISOString(),
        dueBy: dueBy.toISOString(),
      });
      next = advanceAfterCreating(plan, next.nextSequence);
    }
    expect(made).toEqual([
      {
        dueOn: '2026-01-15',
        dueFrom: '2026-01-15T00:00:00.000Z',
        dueBy: '2026-01-15T23:59:00.000Z',
      },
      // Summer time: local midnight is 23:00 the day before in UTC.
      {
        dueOn: '2026-04-15',
        dueFrom: '2026-04-14T23:00:00.000Z',
        dueBy: '2026-04-15T22:59:00.000Z',
      },
      {
        dueOn: '2026-07-15',
        dueFrom: '2026-07-14T23:00:00.000Z',
        dueBy: '2026-07-15T22:59:00.000Z',
      },
      {
        dueOn: '2026-10-15',
        dueFrom: '2026-10-14T23:00:00.000Z',
        dueBy: '2026-10-15T22:59:00.000Z',
      },
    ]);
  });

  it('does not make dates from before it was created', () => {
    const plan = {
      counting: 'calendar',
      interval: quarterly,
      startsOn: '2025-01-10',
      endsOn: null,
    } as const;
    expect(initialNextDue(plan, '2026-05-01', null)).toEqual({
      nextDueOn: '2026-07-10',
      nextSequence: 6,
    });
  });

  it('when changed, does not make a second job for a date already handled', () => {
    const plan = {
      counting: 'calendar',
      interval: { count: 1, unit: 'week' },
      startsOn: '2026-10-05',
      endsOn: null,
    } as const;
    // The job for 2026-11-02 was already made, a week ahead.
    expect(initialNextDue(plan, '2026-10-27', '2026-11-02').nextDueOn).toBe('2026-11-09');
  });

  it('finds the first sequence on or after a day for long intervals too', () => {
    for (const interval of [
      { count: 1, unit: 'day' },
      { count: 2, unit: 'week' },
      { count: 1, unit: 'month' },
      { count: 1, unit: 'year' },
    ] as const) {
      const sequence = firstSequenceFrom('2020-02-29', interval, '2026-10-27');
      expect(calendarDue('2020-02-29', interval, sequence) >= '2026-10-27').toBe(true);
      expect(
        sequence === 0 || calendarDue('2020-02-29', interval, sequence - 1) < '2026-10-27',
      ).toBe(true);
    }
  });

  it('forecasts its dates within its end', () => {
    const plan = {
      counting: 'calendar',
      interval: quarterly,
      startsOn: '2026-01-15',
      endsOn: '2026-12-31',
      nextDueOn: '2026-04-15',
      nextSequence: 1,
    } as const;
    expect(forecastDues(plan, '2026-01-01', '2027-12-31')).toEqual([
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
    ]);
  });
});

describe('a plan counted from completion', () => {
  const plan = {
    counting: 'completion',
    interval: quarterly,
    startsOn: '2026-11-01',
    endsOn: null,
  } as const;

  it('starts on its start date and waits for its job before the next', () => {
    expect(initialNextDue(plan, '2026-10-27', null)).toEqual({
      nextDueOn: '2026-11-01',
      nextSequence: 0,
    });
    expect(advanceAfterCreating(plan, 0)).toEqual({ nextDueOn: null, nextSequence: 0 });
  });

  it('is due one interval after the job was finished', () => {
    expect(nextAfterFinishing(quarterly, '2026-11-20')).toBe('2027-02-20');
  });

  it('forecasts only its next date', () => {
    expect(
      forecastDues(
        { ...plan, nextDueOn: '2027-02-20', nextSequence: 0 },
        '2026-01-01',
        '2028-01-01',
      ),
    ).toEqual(['2027-02-20']);
    expect(
      forecastDues({ ...plan, nextDueOn: null, nextSequence: 0 }, '2026-01-01', '2028-01-01'),
    ).toEqual([]);
  });
});

describe('dates and windows', () => {
  it('creates a job its lead days before it is due', () => {
    expect(creationDay('2026-12-01', 30)).toBe('2026-11-01');
  });

  it('stops at the plan’s or the contract’s end', () => {
    expect(withinPlan('2026-12-01', null, null)).toBe(true);
    expect(withinPlan('2026-12-01', '2026-11-30', null)).toBe(false);
    expect(withinPlan('2026-12-01', null, '2026-11-30')).toBe(false);
  });

  it('adds intervals of every unit', () => {
    expect(addInterval('2026-10-27', { count: 10, unit: 'day' })).toBe('2026-11-06');
    expect(addInterval('2026-10-27', { count: 2, unit: 'week' })).toBe('2026-11-10');
    expect(addInterval('2024-02-29', { count: 1, unit: 'year' })).toBe('2025-02-28');
  });
});

describe('grouping due dates into jobs', () => {
  const base: DueCandidate = {
    key: 'a',
    siteId: 'site-1',
    jobTypeId: 'type-1',
    contractId: null,
    canShare: true,
    dueOn: '2026-12-01',
    window: { from: '2026-11-24', to: '2026-12-08' },
  };

  it('combines plans at one site whose windows meet, inside where they all meet', () => {
    const groups = groupCandidates([
      base,
      { ...base, key: 'b', dueOn: '2026-12-05', window: { from: '2026-11-28', to: '2026-12-12' } },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.candidates.map((c) => c.key)).toEqual(['a', 'b']);
    expect(groups[0]!.window).toEqual({ from: '2026-11-28', to: '2026-12-08' });
  });

  it('keeps apart plans that may not share, or differ in site, type, contract or window', () => {
    const groups = groupCandidates([
      base,
      { ...base, key: 'b', canShare: false },
      { ...base, key: 'c', siteId: 'site-2' },
      { ...base, key: 'd', jobTypeId: 'type-2' },
      { ...base, key: 'e', contractId: 'contract-1' },
      { ...base, key: 'f', dueOn: '2027-01-01', window: { from: '2026-12-25', to: '2027-01-08' } },
    ]);
    expect(groups).toHaveLength(6);
  });
});

describe('maintenance standing', () => {
  it('reads upcoming, created, overdue, completed and cancelled', () => {
    const today = '2026-12-10';
    expect(maintenanceStanding({ dueByDay: '2026-12-31', today })).toBe('upcoming');
    expect(maintenanceStanding({ jobState: 'scheduled', dueByDay: '2026-12-31', today })).toBe(
      'created',
    );
    expect(maintenanceStanding({ jobState: 'dispatched', dueByDay: '2026-12-08', today })).toBe(
      'overdue',
    );
    expect(maintenanceStanding({ jobState: 'reviewed', dueByDay: '2026-12-08', today })).toBe(
      'completed',
    );
    expect(maintenanceStanding({ jobState: 'cancelled', dueByDay: '2026-12-08', today })).toBe(
      'cancelled',
    );
  });
});
