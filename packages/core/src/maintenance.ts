import { z } from 'zod';
import { addMonths, daysBetween, earlierDay, laterDay, zonedInstant } from './calendar.js';
import { addDays } from './finance.js';

/**
 * Maintenance plans (P27): recurring servicing of one asset.
 *
 * A plan counts its due dates one of two ways:
 *
 * - `calendar`: every interval from the start date, whatever happened. The
 *   n-th date is always worked out from the start date, never from the date
 *   before it, so a plan that starts on the 31st comes back to the 31st after
 *   a shorter month.
 * - `completion`: one interval after the previous job was completed (or, if it
 *   was cancelled, after the date it was due).
 *
 * Due dates are calendar days in the company's time zone. A job is created
 * `leadDays` before its due date, and its due window runs from the start of
 * `windowBeforeDays` before to the end of `windowAfterDays` after.
 */

export const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const;
export const intervalUnitSchema = z.enum(INTERVAL_UNITS);
export type IntervalUnit = z.infer<typeof intervalUnitSchema>;

export const PLAN_COUNTINGS = ['calendar', 'completion'] as const;
export const planCountingSchema = z.enum(PLAN_COUNTINGS);
export type PlanCounting = z.infer<typeof planCountingSchema>;

export const PLAN_STATUSES = ['active', 'paused', 'ended'] as const;
export const planStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const OCCURRENCE_STATUSES = ['created', 'skipped'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const OCCURRENCE_SKIP_REASONS = ['asset_retired', 'contract_ended', 'plan_ended'] as const;
export type OccurrenceSkipReason = (typeof OCCURRENCE_SKIP_REASONS)[number];

export const PLAN_INTERVAL_MAX = 120;
export const PLAN_WINDOW_DAYS_MAX = 365;
export const PLAN_LEAD_DAYS_MAX = 365;
export const DEFAULT_PLAN_LEAD_DAYS = 30;
export const DEFAULT_PLAN_WINDOW_DAYS = 7;

/** How far ahead the maintenance screen forecasts. */
export const MAINTENANCE_FORECAST_DAYS = 365;

export interface PlanInterval {
  count: number;
  unit: IntervalUnit;
}

/** `times` intervals after `day`. */
export function addInterval(day: string, interval: PlanInterval, times = 1): string {
  const steps = interval.count * times;
  switch (interval.unit) {
    case 'day':
      return addDays(day, steps);
    case 'week':
      return addDays(day, steps * 7);
    case 'month':
      return addMonths(day, steps);
    case 'year':
      return addMonths(day, steps * 12);
  }
}

/** The n-th due date of a calendar plan; 0 is the start date. */
export function calendarDue(startsOn: string, interval: PlanInterval, sequence: number): string {
  return addInterval(startsOn, interval, sequence);
}

/**
 * The first sequence of a calendar plan due on or after `notBefore`. Used when
 * a plan is created or changed: dates already behind it are not made.
 */
export function firstSequenceFrom(
  startsOn: string,
  interval: PlanInterval,
  notBefore: string,
): number {
  if (notBefore <= startsOn) {
    return 0;
  }
  // A close estimate first, then step: months are uneven.
  const approxDays =
    interval.unit === 'day'
      ? interval.count
      : interval.unit === 'week'
        ? interval.count * 7
        : interval.unit === 'month'
          ? interval.count * 28
          : interval.count * 365;
  let sequence = Math.max(0, Math.floor(daysBetween(startsOn, notBefore) / approxDays) - 1);
  while (sequence > 0 && calendarDue(startsOn, interval, sequence) >= notBefore) {
    sequence -= 1;
  }
  while (calendarDue(startsOn, interval, sequence) < notBefore) {
    sequence += 1;
  }
  return sequence;
}

export interface PlanSchedule {
  counting: PlanCounting;
  interval: PlanInterval;
  startsOn: string;
  endsOn: string | null;
}

/** Where a plan's next job comes from. */
export interface NextDue {
  /** Null when a completion plan waits for its open job to finish. */
  nextDueOn: string | null;
  nextSequence: number;
}

/**
 * Where a plan starts, or starts again after it was changed. `today` is the
 * company's day; dates before it are not made. `lastDueOn` is the latest date
 * the plan already made a job (or a skip) for, so a change never makes a
 * second one for a date already handled.
 */
export function initialNextDue(
  plan: PlanSchedule,
  today: string,
  lastDueOn: string | null,
): NextDue {
  const notBefore = lastDueOn === null ? today : laterDay(today, addDays(lastDueOn, 1));
  if (plan.counting === 'calendar') {
    const sequence = firstSequenceFrom(plan.startsOn, plan.interval, notBefore);
    return {
      nextDueOn: calendarDue(plan.startsOn, plan.interval, sequence),
      nextSequence: sequence,
    };
  }
  return { nextDueOn: laterDay(plan.startsOn, notBefore), nextSequence: 0 };
}

/**
 * After a calendar plan made the job for `sequence`, the next one. A
 * completion plan has no next date until its job is finished.
 */
export function advanceAfterCreating(plan: PlanSchedule, sequence: number): NextDue {
  if (plan.counting === 'calendar') {
    return {
      nextDueOn: calendarDue(plan.startsOn, plan.interval, sequence + 1),
      nextSequence: sequence + 1,
    };
  }
  return { nextDueOn: null, nextSequence: 0 };
}

/**
 * A completion plan's next date, once its last job is finished: one interval
 * after the day it was completed, or after the day it was due if it was
 * cancelled instead.
 */
export function nextAfterFinishing(interval: PlanInterval, finishedOn: string): string {
  return addInterval(finishedOn, interval);
}

/** Whether a date is still within the plan, by its own end date and its contract's. */
export function withinPlan(
  dueOn: string,
  planEndsOn: string | null,
  contractEndsOn: string | null,
): boolean {
  return (
    (planEndsOn === null || dueOn <= planEndsOn) &&
    (contractEndsOn === null || dueOn <= contractEndsOn)
  );
}

/** The day a job for `dueOn` is created. */
export function creationDay(dueOn: string, leadDays: number): string {
  return addDays(dueOn, -leadDays);
}

export interface DayWindow {
  from: string;
  to: string;
}

/** The due window around a due date, as days. */
export function windowDays(dueOn: string, before: number, after: number): DayWindow {
  return { from: addDays(dueOn, -before), to: addDays(dueOn, after) };
}

/**
 * A window of days as the job's due-from and due-by instants: the start of the
 * first day and the last minute of the last, in the company's zone.
 */
export function windowInstants(
  window: DayWindow,
  timeZone: string,
): { dueFrom: Date; dueBy: Date } {
  return {
    dueFrom: zonedInstant(window.from, 0, timeZone),
    dueBy: zonedInstant(window.to, 24 * 60 - 1, timeZone),
  };
}

/**
 * A calendar plan's due dates between two days, for the forecast. A
 * completion plan only knows its next one.
 */
export function forecastDues(
  plan: PlanSchedule & { nextDueOn: string | null; nextSequence: number },
  from: string,
  to: string,
  limit = 60,
): string[] {
  if (plan.nextDueOn === null) {
    return [];
  }
  if (plan.counting === 'completion') {
    return plan.nextDueOn >= from &&
      plan.nextDueOn <= to &&
      withinPlan(plan.nextDueOn, plan.endsOn, null)
      ? [plan.nextDueOn]
      : [];
  }
  const dues: string[] = [];
  let sequence = plan.nextSequence;
  for (;;) {
    const due = calendarDue(plan.startsOn, plan.interval, sequence);
    if (due > to || !withinPlan(due, plan.endsOn, null) || dues.length >= limit) {
      break;
    }
    if (due >= from) {
      dues.push(due);
    }
    sequence += 1;
  }
  return dues;
}

/** One due date waiting for a job, as the worker groups them. */
export interface DueCandidate {
  /** The caller's own handle on it. */
  key: string;
  siteId: string;
  jobTypeId: string;
  contractId: string | null;
  canShare: boolean;
  dueOn: string;
  window: DayWindow;
}

export interface CandidateGroup {
  candidates: DueCandidate[];
  /** The days every member's window allows. */
  window: DayWindow;
  /** The earliest member's due date. */
  dueOn: string;
}

/**
 * Combines due dates into jobs. Plans that may share, at the same site, with
 * the same job type and the same contract, whose windows overlap, become one
 * job whose window is where all of theirs meet. A plan that may not share
 * always has a job of its own.
 */
export function groupCandidates(candidates: readonly DueCandidate[]): CandidateGroup[] {
  const sorted = [...candidates].sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.key.localeCompare(b.key),
  );
  const groups: CandidateGroup[] = [];
  for (const candidate of sorted) {
    const match = candidate.canShare
      ? groups.find((group) => {
          const first = group.candidates[0]!;
          return (
            first.canShare &&
            first.siteId === candidate.siteId &&
            first.jobTypeId === candidate.jobTypeId &&
            first.contractId === candidate.contractId &&
            windowsMeet(group.window, candidate.window)
          );
        })
      : undefined;
    if (match === undefined) {
      groups.push({ candidates: [candidate], window: candidate.window, dueOn: candidate.dueOn });
    } else {
      match.candidates.push(candidate);
      match.window = {
        from: laterDay(match.window.from, candidate.window.from),
        to: earlierDay(match.window.to, candidate.window.to),
      };
    }
  }
  return groups;
}

/** Whether two windows share at least one day. */
export function windowsMeet(a: DayWindow, b: DayWindow): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** Where a planned due date stands, for the maintenance screen. */
export type MaintenanceStanding = 'upcoming' | 'created' | 'completed' | 'overdue' | 'cancelled';

export function maintenanceStanding(input: {
  /** The job's state, or undefined when no job has been made yet. */
  jobState?: string | undefined;
  /** The last day of the job's window. */
  dueByDay: string;
  today: string;
}): MaintenanceStanding {
  const { jobState } = input;
  if (jobState === undefined) {
    return 'upcoming';
  }
  if (jobState === 'complete' || jobState === 'reviewed') {
    return 'completed';
  }
  if (jobState === 'cancelled') {
    return 'cancelled';
  }
  return input.today > input.dueByDay ? 'overdue' : 'created';
}
