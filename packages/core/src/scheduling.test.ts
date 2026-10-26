import { describe, expect, it } from 'vitest';
import {
  findDoubleBookings,
  type PlannedVisit,
  slotProblem,
  slotsOverlap,
  snapToMinutes,
  visitWarnings,
} from './scheduling.js';

const at = (time: string) => new Date(`2026-11-02T${time}:00Z`);

const visit = (overrides: Partial<PlannedVisit> = {}): PlannedVisit => ({
  id: 'v1',
  workOrderId: 'job-a',
  status: 'planned',
  startsAt: at('08:00'),
  endsAt: at('10:00'),
  assigneeIds: ['ahmed'],
  ...overrides,
});

describe('slots', () => {
  it('refuses a slot that ends before it starts, or lasts more than a week', () => {
    expect(slotProblem({ startsAt: at('10:00'), endsAt: at('10:00') })).toBe('ends_before_start');
    expect(slotProblem({ startsAt: at('10:00'), endsAt: new Date('2026-11-10T10:00:00Z') })).toBe(
      'too_long',
    );
    expect(slotProblem({ startsAt: at('08:00'), endsAt: at('10:00') })).toBeUndefined();
  });

  it('treats touching slots as not overlapping', () => {
    const first = { startsAt: at('08:00'), endsAt: at('10:00') };
    expect(slotsOverlap(first, { startsAt: at('10:00'), endsAt: at('11:00') })).toBe(false);
    expect(slotsOverlap(first, { startsAt: at('09:59'), endsAt: at('11:00') })).toBe(true);
  });

  it('snaps to the nearest quarter hour', () => {
    expect(snapToMinutes(at('08:07')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(snapToMinutes(at('08:08')).toISOString()).toBe('2026-11-02T08:15:00.000Z');
  });
});

describe('double booking', () => {
  it('finds the same person on an overlapping visit of another job', () => {
    const other = visit({
      id: 'v2',
      workOrderId: 'job-b',
      startsAt: at('09:00'),
      endsAt: at('11:00'),
    });
    expect(findDoubleBookings(visit(), [other])).toEqual([
      { userId: 'ahmed', visitId: 'v1', conflictingVisitId: 'v2', conflictingWorkOrderId: 'job-b' },
    ]);
  });

  it('allows overlapping visits of the same job', () => {
    const sameJob = visit({ id: 'v2', startsAt: at('09:00'), endsAt: at('11:00') });
    expect(findDoubleBookings(visit(), [sameJob])).toEqual([]);
  });

  it('ignores other people, and visits that are done or cancelled', () => {
    const others = [
      visit({ id: 'v2', workOrderId: 'job-b', assigneeIds: ['sara'] }),
      visit({ id: 'v3', workOrderId: 'job-c', status: 'done' }),
      visit({ id: 'v4', workOrderId: 'job-d', status: 'cancelled' }),
    ];
    expect(findDoubleBookings(visit(), others)).toEqual([]);
  });

  it('does not compare a visit with itself', () => {
    expect(findDoubleBookings(visit(), [visit({ workOrderId: 'job-b' })])).toEqual([]);
  });
});

describe('warnings', () => {
  const window = { dueFrom: at('07:00'), dueBy: at('12:00') };

  it('warns when a visit falls outside the job’s due window', () => {
    expect(visitWarnings(visit(), window)).toEqual([]);
    expect(visitWarnings(visit({ endsAt: at('13:00') }), window)).toEqual(['outside_due_window']);
    expect(visitWarnings(visit({ startsAt: at('06:00') }), window)).toEqual(['outside_due_window']);
  });

  it('warns when nobody is on a visit', () => {
    expect(visitWarnings(visit({ assigneeIds: [] }), { dueFrom: null, dueBy: null })).toEqual([
      'no_engineer',
    ]);
  });

  it('never warns about working hours, or about visits that are over', () => {
    const night = visit({ startsAt: at('23:00'), endsAt: new Date('2026-11-03T03:00:00Z') });
    expect(visitWarnings(night, { dueFrom: null, dueBy: null })).toEqual([]);
    expect(visitWarnings(visit({ status: 'done', assigneeIds: [] }), window)).toEqual([]);
  });
});
