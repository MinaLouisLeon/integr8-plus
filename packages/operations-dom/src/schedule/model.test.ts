import { describe, expect, it } from 'vitest';
import {
  dayKey,
  firstDayOfWeek,
  fromDayKey,
  initials,
  layoutLanes,
  rangeFor,
  segmentOn,
  snapMinutes,
  stepAnchor,
} from './model.js';

const local = (day: number, time = '00:00', month = 11) => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2026, month - 1, day, hours, minutes);
};

describe('views', () => {
  it('shows one day, the week containing the day, or whole weeks covering the month', () => {
    // Wednesday 4 November 2026; weeks start on Monday.
    const anchor = local(4, '15:30');
    expect(dayKey(rangeFor('day', anchor, 1).from)).toBe('2026-11-04');
    const week = rangeFor('week', anchor, 1);
    expect(week.days.map(dayKey)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    const month = rangeFor('month', anchor, 1);
    expect(dayKey(month.days[0]!)).toBe('2026-10-26');
    expect(dayKey(month.days.at(-1)!)).toBe('2026-12-06');
    expect(month.days).toHaveLength(42);
  });

  it('starts the week on Saturday where that is the custom', () => {
    expect(dayKey(rangeFor('week', local(4), 6).from)).toBe('2026-10-31');
  });

  it('steps by a day, a week or a month', () => {
    expect(dayKey(stepAnchor('day', local(4), 1))).toBe('2026-11-05');
    expect(dayKey(stepAnchor('week', local(4), -1))).toBe('2026-10-28');
    expect(dayKey(stepAnchor('month', local(30), 1))).toBe('2026-12-01');
  });

  it('knows a sensible first day of the week', () => {
    expect([0, 1, 6]).toContain(firstDayOfWeek('en'));
    expect([0, 6]).toContain(firstDayOfWeek('ar'));
  });

  it('round-trips a day key', () => {
    expect(dayKey(fromDayKey('2026-02-28'))).toBe('2026-02-28');
  });
});

describe('placing a visit in a day', () => {
  it('places a visit by its minutes from midnight', () => {
    expect(
      segmentOn({ id: 'a', start: local(2, '08:00'), end: local(2, '10:30') }, local(2)),
    ).toEqual({
      top: 480,
      length: 150,
      continuesFrom: false,
      continuesTo: false,
    });
  });

  it('splits a night shift across the two days it touches', () => {
    const night = { id: 'n', start: local(2, '22:00'), end: local(3, '03:00') };
    expect(segmentOn(night, local(2))).toMatchObject({ top: 1320, length: 120, continuesTo: true });
    expect(segmentOn(night, local(3))).toMatchObject({ top: 0, length: 180, continuesFrom: true });
    expect(segmentOn(night, local(4))).toBeUndefined();
  });
});

describe('sharing a day between overlapping visits', () => {
  it('puts overlapping visits side by side and lone visits full width', () => {
    const lanes = layoutLanes([
      { id: 'a', start: local(2, '08:00'), end: local(2, '10:00') },
      { id: 'b', start: local(2, '09:00'), end: local(2, '11:00') },
      { id: 'c', start: local(2, '10:00'), end: local(2, '12:00') },
      { id: 'd', start: local(2, '13:00'), end: local(2, '14:00') },
    ]);
    expect(lanes.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get('b')).toEqual({ lane: 1, lanes: 2 });
    // c starts when a ends: it reuses a's lane.
    expect(lanes.get('c')).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get('d')).toEqual({ lane: 0, lanes: 1 });
  });
});

describe('small things', () => {
  it('snaps to a quarter hour', () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(-22)).toBe(-15);
  });

  it('makes initials, in any script', () => {
    expect(initials('sara ahmed')).toBe('SA');
    expect(initials('عمر')).toBe('ع');
    expect(initials('  ')).toBe('?');
  });
});
