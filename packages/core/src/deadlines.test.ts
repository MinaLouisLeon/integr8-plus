import { describe, expect, it } from 'vitest';
import {
  addWorkingMinutes,
  complianceSummary,
  deadlinesFor,
  deadlineState,
  type WorkingHours,
} from './deadlines.js';

// 08:00 to 17:00, Monday to Friday, in London.
const hours: WorkingHours = {
  timeZone: 'Europe/London',
  startsMinute: 8 * 60,
  endsMinute: 17 * 60,
  days: [1, 2, 3, 4, 5],
};

describe('the working-hours clock', () => {
  it('counts within the day', () => {
    // Tuesday 27 October 2026, 10:00 GMT.
    expect(addWorkingMinutes(new Date('2026-10-27T10:00:00Z'), 120, hours)?.toISOString()).toBe(
      '2026-10-27T12:00:00.000Z',
    );
  });

  it('carries over the night and the weekend', () => {
    // Friday 30 October, 16:00: one hour left that day, three more on Monday.
    expect(addWorkingMinutes(new Date('2026-10-30T16:00:00Z'), 240, hours)?.toISOString()).toBe(
      '2026-11-02T11:00:00.000Z',
    );
  });

  it('starts at opening time when the job comes in before it', () => {
    expect(addWorkingMinutes(new Date('2026-10-27T05:00:00Z'), 30, hours)?.toISOString()).toBe(
      '2026-10-27T08:30:00.000Z',
    );
  });

  it('follows the local working day across the clock change', () => {
    // Friday 23 October, 16:00 BST (15:00 UTC); the clocks go back on Sunday.
    expect(addWorkingMinutes(new Date('2026-10-23T15:00:00Z'), 120, hours)?.toISOString()).toBe(
      '2026-10-26T09:00:00.000Z',
    );
  });

  it('never runs for a company with no working days', () => {
    expect(addWorkingMinutes(new Date(), 60, { ...hours, days: [] })).toBeUndefined();
  });
});

describe('a job’s deadlines', () => {
  const created = new Date('2026-10-30T16:00:00Z');

  it('count every minute around the clock', () => {
    expect(
      deadlinesFor(
        created,
        { responseMinutes: 120, completionMinutes: 480, clock: 'always' },
        hours,
      ),
    ).toEqual({
      responseDueAt: new Date('2026-10-30T18:00:00Z'),
      completionDueAt: new Date('2026-10-31T00:00:00Z'),
    });
  });

  it('count only working hours when the rule says so', () => {
    expect(
      deadlinesFor(
        created,
        { responseMinutes: 120, completionMinutes: null, clock: 'working_hours' },
        hours,
      ),
    ).toEqual({ responseDueAt: new Date('2026-11-02T09:00:00Z'), completionDueAt: null });
  });

  it('are absent when the clock can never reach them', () => {
    expect(
      deadlinesFor(
        created,
        { responseMinutes: 60, completionMinutes: null, clock: 'working_hours' },
        { ...hours, days: [] },
      ),
    ).toBeUndefined();
  });
});

describe('a deadline’s state', () => {
  const dueAt = new Date('2026-10-27T12:00:00Z');
  const at = (time: string) => new Date(`2026-10-27T${time}:00Z`);

  it('reads met, met late, missed, warning, running and closed', () => {
    const state = (input: Partial<Parameters<typeof deadlineState>[0]>) =>
      deadlineState({
        dueAt,
        metAt: null,
        closedAt: null,
        warnMinutes: 30,
        now: at('10:00'),
        ...input,
      });
    expect(state({ metAt: at('11:00') })).toBe('met');
    expect(state({ metAt: at('12:30') })).toBe('met_late');
    expect(state({ now: at('12:01') })).toBe('missed');
    expect(state({ now: at('11:45') })).toBe('warning');
    expect(state({})).toBe('running');
    expect(state({ closedAt: at('11:00'), now: at('13:00') })).toBe('closed');
    expect(state({ closedAt: at('12:30'), now: at('13:00') })).toBe('missed');
  });
});

describe('compliance', () => {
  it('counts on-time responses and completions and every miss', () => {
    const createdAt = new Date('2026-10-27T08:00:00Z');
    const summary = complianceSummary([
      {
        createdAt,
        responseDueAt: new Date('2026-10-27T10:00:00Z'),
        respondedAt: new Date('2026-10-27T09:00:00Z'),
        completionDueAt: new Date('2026-10-27T16:00:00Z'),
        completedAt: new Date('2026-10-27T17:00:00Z'),
        responseMissed: false,
        completionMissed: true,
      },
      {
        createdAt,
        responseDueAt: new Date('2026-10-27T10:00:00Z'),
        respondedAt: new Date('2026-10-27T11:00:00Z'),
        completionDueAt: null,
        completedAt: null,
        responseMissed: true,
        completionMissed: false,
      },
    ]);
    expect(summary).toEqual({
      jobs: 2,
      responseDue: 2,
      respondedOnTime: 1,
      completionDue: 1,
      completedOnTime: 0,
      missed: 2,
      averageResponseMinutes: 120,
    });
  });
});
