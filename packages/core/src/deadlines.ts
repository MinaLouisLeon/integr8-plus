import { z } from 'zod';
import { calendarDay } from './qualifications.js';
import { isoWeekday, zonedInstant } from './calendar.js';
import { addDays } from './finance.js';
import type { WorkOrderPriority } from './work-orders.js';

/**
 * Response deadlines (P27).
 *
 * The company sets, per priority, how long it has to respond to a job (to
 * dispatch it) and to complete it, counted from when the job was created.
 * Each rule counts either every minute or only the company's working hours.
 * The clock never pauses. A deadline met late is a miss as much as one never
 * met; both are recorded in the job's history.
 */

export const DEADLINE_CLOCKS = ['always', 'working_hours'] as const;
export const deadlineClockSchema = z.enum(DEADLINE_CLOCKS);
export type DeadlineClock = z.infer<typeof deadlineClockSchema>;

export const DEADLINE_KINDS = ['response', 'completion'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

/** A year, in minutes: the longest deadline a rule may set. */
export const DEADLINE_MINUTES_MAX = 525_600;
/** A week, in minutes: the earliest a warning may go out. */
export const DEADLINE_WARN_MINUTES_MAX = 10_080;
export const DEFAULT_DEADLINE_WARN_MINUTES = 30;

export interface DeadlineRule {
  priority: WorkOrderPriority;
  responseMinutes: number | null;
  completionMinutes: number | null;
  clock: DeadlineClock;
  warnMinutes: number;
}

/** The company's working week, as stored in its settings. */
export interface WorkingHours {
  timeZone: string;
  /** Minutes from midnight. */
  startsMinute: number;
  endsMinute: number;
  /** ISO weekdays: 1 is Monday. */
  days: readonly number[];
}

/** How far the working-hours clock looks ahead before giving up. */
const MAX_DAYS_SEARCHED = 3700;

/**
 * The instant `minutes` working minutes after `start`. Undefined when the
 * company has no working days, so the clock can never run. Public holidays
 * are not known and count as working days.
 */
export function addWorkingMinutes(
  start: Date,
  minutes: number,
  hours: WorkingHours,
): Date | undefined {
  if (hours.days.length === 0 || hours.endsMinute <= hours.startsMinute) {
    return undefined;
  }
  let remaining = minutes * 60_000;
  let day = calendarDay(start, hours.timeZone);
  for (let searched = 0; searched < MAX_DAYS_SEARCHED; searched += 1, day = addDays(day, 1)) {
    if (!hours.days.includes(isoWeekday(day))) {
      continue;
    }
    const opens = zonedInstant(day, hours.startsMinute, hours.timeZone).getTime();
    const closes = zonedInstant(day, hours.endsMinute, hours.timeZone).getTime();
    const from = Math.max(start.getTime(), opens);
    if (from >= closes) {
      continue;
    }
    if (remaining <= closes - from) {
      return new Date(from + remaining);
    }
    remaining -= closes - from;
  }
  return undefined;
}

/** The instant a deadline of `minutes` falls, by the rule's clock. */
export function deadlineAfter(
  start: Date,
  minutes: number,
  clock: DeadlineClock,
  hours: WorkingHours,
): Date | undefined {
  return clock === 'always'
    ? new Date(start.getTime() + minutes * 60_000)
    : addWorkingMinutes(start, minutes, hours);
}

export interface JobDeadlines {
  responseDueAt: Date | null;
  completionDueAt: Date | null;
}

/**
 * A job's deadlines under a rule, counted from its creation. Undefined when the
 * rule sets nothing the clock can reach.
 */
export function deadlinesFor(
  createdAt: Date,
  rule: Pick<DeadlineRule, 'responseMinutes' | 'completionMinutes' | 'clock'>,
  hours: WorkingHours,
): JobDeadlines | undefined {
  const responseDueAt =
    rule.responseMinutes === null
      ? null
      : (deadlineAfter(createdAt, rule.responseMinutes, rule.clock, hours) ?? null);
  const completionDueAt =
    rule.completionMinutes === null
      ? null
      : (deadlineAfter(createdAt, rule.completionMinutes, rule.clock, hours) ?? null);
  return responseDueAt === null && completionDueAt === null
    ? undefined
    : { responseDueAt, completionDueAt };
}

/**
 * Where one deadline stands:
 *
 * - `met` / `met_late`: it was met, in time or not.
 * - `missed`: it passed unmet.
 * - `warning`: unmet, and within the warning before it.
 * - `running`: unmet, with time left.
 * - `closed`: the job was cancelled before it was met.
 */
export type DeadlineState = 'met' | 'met_late' | 'missed' | 'warning' | 'running' | 'closed';

export function deadlineState(input: {
  dueAt: Date;
  metAt: Date | null;
  closedAt: Date | null;
  warnMinutes: number;
  now: Date;
}): DeadlineState {
  if (input.metAt !== null) {
    return input.metAt.getTime() > input.dueAt.getTime() ? 'met_late' : 'met';
  }
  if (input.now.getTime() > input.dueAt.getTime()) {
    // A job cancelled before its deadline passed did not miss it.
    return input.closedAt !== null && input.closedAt.getTime() <= input.dueAt.getTime()
      ? 'closed'
      : 'missed';
  }
  if (input.closedAt !== null) {
    return 'closed';
  }
  return input.dueAt.getTime() - input.now.getTime() <= input.warnMinutes * 60_000
    ? 'warning'
    : 'running';
}

export interface ComplianceJob {
  responseDueAt: Date | null;
  respondedAt: Date | null;
  completionDueAt: Date | null;
  completedAt: Date | null;
  responseMissed: boolean;
  completionMissed: boolean;
  createdAt: Date;
}

export interface ComplianceSummary {
  jobs: number;
  responseDue: number;
  respondedOnTime: number;
  completionDue: number;
  completedOnTime: number;
  missed: number;
  /** Mean minutes from creation to response, over jobs responded to; null when none were. */
  averageResponseMinutes: number | null;
}

/** One customer's (or the company's) record against its deadlines. */
export function complianceSummary(jobs: readonly ComplianceJob[]): ComplianceSummary {
  let responseDue = 0;
  let respondedOnTime = 0;
  let completionDue = 0;
  let completedOnTime = 0;
  let missed = 0;
  let responseTotal = 0;
  let responded = 0;
  for (const job of jobs) {
    if (job.responseDueAt !== null) {
      responseDue += 1;
      if (job.respondedAt !== null && !job.responseMissed) {
        respondedOnTime += 1;
      }
    }
    if (job.completionDueAt !== null) {
      completionDue += 1;
      if (job.completedAt !== null && !job.completionMissed) {
        completedOnTime += 1;
      }
    }
    if (job.responseMissed) {
      missed += 1;
    }
    if (job.completionMissed) {
      missed += 1;
    }
    if (job.respondedAt !== null) {
      responded += 1;
      responseTotal += (job.respondedAt.getTime() - job.createdAt.getTime()) / 60_000;
    }
  }
  return {
    jobs: jobs.length,
    responseDue,
    respondedOnTime,
    completionDue,
    completedOnTime,
    missed,
    averageResponseMinutes: responded === 0 ? null : Math.round(responseTotal / responded),
  };
}
