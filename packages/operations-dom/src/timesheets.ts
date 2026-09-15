import { findTransition, jobTimes, shiftDurationMs, type StateChange } from '@integr8/core';
import type { Timesheet } from './api.js';

/**
 * A timesheet, added up.
 *
 * The API returns raw facts — shifts, and the state changes each person made —
 * and every total here comes from `shiftDurationMs` and `jobTimes` in
 * `@integr8/core`, the same rules the phone shows an engineer. Nothing is timed
 * any other way; this only decides which day and which person a stretch
 * belongs to.
 *
 * Days are the viewer's local calendar days, and a week runs Monday to Sunday.
 */

export interface Totals {
  shiftMs: number;
  travelMs: number;
  onSiteMs: number;
  workMs: number;
}

export interface TimesheetShift {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
}

export interface TimesheetJob {
  workOrderId: string;
  referenceLabel: string;
  title: string;
  travelMs: number;
  onSiteMs: number;
  workMs: number;
}

export interface TimesheetDay {
  /** Local midnight. */
  day: Date;
  shifts: TimesheetShift[];
  jobs: TimesheetJob[];
  totals: Totals;
}

export interface TimesheetPerson {
  person: { id: string; name: string };
  days: TimesheetDay[];
  totals: Totals;
}

/** Local midnight on the Monday of the week `date` falls in. */
export function startOfWeek(date: Date): Date {
  const sinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday);
}

/** Calendar days, so a week that crosses a clock change is still seven days. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** A local calendar day as `YYYY-MM-DD`, the value of a date input. */
export function dayKey(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** A date input's `YYYY-MM-DD`, as local midnight. */
export function parseDayKey(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const zero = (): Totals => ({ shiftMs: 0, travelMs: 0, onSiteMs: 0, workMs: 0 });

function add(into: Totals, from: Partial<Totals>): void {
  into.shiftMs += from.shiftMs ?? 0;
  into.travelMs += from.travelMs ?? 0;
  into.onSiteMs += from.onSiteMs ?? 0;
  into.workMs += from.workMs ?? 0;
}

type Change = Timesheet['changes'][number];

/**
 * Each person's days in the window, with week totals.
 *
 * - A shift belongs to the day it started on (a shift that started before the
 *   window, to the window's first day), and counts in full.
 * - A job's time is `jobTimes` over the job's own changes, whoever tapped them,
 *   and it counts for everyone on its crew — and for anyone else who travelled,
 *   arrived or worked on it. A crew shares one job: the engineer who taps
 *   "arrived" and the one who taps "start work" were both there.
 * - Its changes are split by the day each was made; a day's last stretch runs to
 *   the next change, even one made after midnight, so it counts on the day it
 *   began. A change from before the window counts from the window's start. The
 *   stretch the job is in now counts up to `now` while the window is still open.
 * - People with no shift and no time on a job — the office moving jobs along —
 *   are left out.
 */
export function summarizeTimesheet(
  sheet: Timesheet,
  window: { from: Date; to: Date },
  now: Date,
): TimesheetPerson[] {
  const names = new Map(sheet.people.map((person) => [person.id, person.name]));
  const jobs = new Map(sheet.workOrders.map((job) => [job.id, job]));
  const people = new Map<string, Map<string, TimesheetDay>>();

  const dayFor = (personId: string, at: Date): TimesheetDay => {
    const counted = at < window.from ? window.from : at;
    const key = dayKey(counted);
    let days = people.get(personId);
    if (days === undefined) {
      days = new Map();
      people.set(personId, days);
    }
    let day = days.get(key);
    if (day === undefined) {
      day = {
        day: new Date(counted.getFullYear(), counted.getMonth(), counted.getDate()),
        shifts: [],
        jobs: [],
        totals: zero(),
      };
      days.set(key, day);
    }
    return day;
  };

  for (const shift of [...sheet.shifts].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  )) {
    const durationMs = shiftDurationMs(shift, now);
    const day = dayFor(shift.userId, new Date(shift.startedAt));
    day.shifts.push({
      id: shift.id,
      startedAt: shift.startedAt,
      endedAt: shift.endedAt,
      durationMs,
    });
    day.totals.shiftMs += durationMs;
  }

  const byJob = new Map<string, Change[]>();
  for (const change of sheet.changes) {
    // Before the window, it counts from the window's start.
    const counted =
      Date.parse(change.occurredAt) < window.from.getTime()
        ? { ...change, occurredAt: window.from.toISOString() }
        : change;
    byJob.set(change.workOrderId, [...(byJob.get(change.workOrderId) ?? []), counted]);
  }
  const crews = new Map<string, Set<string>>();
  for (const member of sheet.crews) {
    crews.set(member.workOrderId, (crews.get(member.workOrderId) ?? new Set()).add(member.userId));
  }
  const open = now >= window.from && now < window.to;

  for (const [workOrderId, changes] of byJob) {
    const ordered = [...changes].sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );
    const workers = new Set(crews.get(workOrderId));
    for (const change of ordered) {
      if (findTransition(change.fromState, change.toState)?.permission === 'work_order.progress') {
        workers.add(change.actorId);
      }
    }
    const runs: Change[][] = [];
    for (const change of ordered) {
      const last = runs.at(-1);
      if (
        last !== undefined &&
        dayKey(new Date(last[0]!.occurredAt)) === dayKey(new Date(change.occurredAt))
      ) {
        last.push(change);
      } else {
        runs.push([change]);
      }
    }
    const job = jobs.get(workOrderId);

    runs.forEach((run, index) => {
      const first = run[0]!;
      const next = runs[index + 1]?.[0];
      const final = run.at(-1)!;
      // Only the job's latest stretch runs on to now, and only if nothing has moved it since.
      const current = next === undefined && open && job?.state === final.toState ? now : undefined;
      const input: StateChange[] = next === undefined ? run : [...run, next];
      const times = jobTimes(input, current);
      if (times.travelMs === 0 && times.onSiteMs === 0 && times.workMs === 0) {
        return;
      }
      for (const personId of workers) {
        if (!names.has(personId)) {
          continue;
        }
        const day = dayFor(personId, new Date(first.occurredAt));
        day.jobs.push({
          workOrderId,
          referenceLabel: job?.referenceLabel ?? '',
          title: job?.title ?? '',
          travelMs: times.travelMs,
          onSiteMs: times.onSiteMs,
          workMs: times.workMs,
        });
        add(day.totals, times);
      }
    });
  }

  return [...people.entries()]
    .map(([personId, days]) => {
      const ordered = [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, day]) => day);
      const totals = zero();
      for (const day of ordered) {
        add(totals, day.totals);
      }
      return {
        person: { id: personId, name: names.get(personId) ?? personId },
        days: ordered,
        totals,
      };
    })
    .sort((a, b) => a.person.name.localeCompare(b.person.name));
}
