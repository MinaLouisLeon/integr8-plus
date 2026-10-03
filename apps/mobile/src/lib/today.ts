import { nextStates, type WorkOrderState } from '@integr8/core';
import { type JobListItem, sectionJobs } from '@integr8/offline';

/**
 * The engineer's day, decided from the jobs on the phone (P14): which job is
 * next, what the one step forward on it is, and what else they may do.
 *
 * Pure, so the rules are tested without a phone.
 */

/** States in which the engineer is already out on a job, in the order they happen. */
const UNDER_WAY: readonly WorkOrderState[] = ['in_progress', 'on_site', 'travelling'];

/** Today's work: overdue first, then what is due today, each soonest first. */
export function dayJobs(open: readonly JobListItem[], now: Date): JobListItem[] {
  const sections = sectionJobs(open, now);
  return [...sections.overdue, ...sections.today];
}

/**
 * The job to show first. One the engineer is travelling to or working on wins,
 * whatever its date: it is where they are. After that, the first job of the day
 * that is theirs to start.
 */
export function nextJob(open: readonly JobListItem[], now: Date): JobListItem | undefined {
  for (const state of UNDER_WAY) {
    const found = open.find((job) => job.state === state);
    if (found !== undefined) {
      return found;
    }
  }
  const day = dayJobs(open, now);
  return (
    day.find((job) => job.state === 'dispatched') ??
    day.find((job) => job.state === 'awaiting_parts') ??
    day[0]
  );
}

/**
 * The step an engineer takes next on a job, in the order a visit goes: travel,
 * arrive, start work, complete. Undefined when the next step is the office's.
 */
export const PRIMARY_STEP: Partial<Record<WorkOrderState, WorkOrderState>> = {
  dispatched: 'travelling',
  travelling: 'on_site',
  on_site: 'in_progress',
  in_progress: 'complete',
  awaiting_parts: 'in_progress',
};

export interface JobSteps {
  primary: WorkOrderState | undefined;
  others: WorkOrderState[];
}

/** What the engineer may do to a job from its screen: only their own transitions, never the office's. */
export function jobSteps(state: WorkOrderState): JobSteps {
  const allowed = nextStates(state)
    .filter((transition) => transition.permission === 'work_order.progress')
    .map((transition) => transition.to);
  const primary = PRIMARY_STEP[state];
  return {
    primary: primary !== undefined && allowed.includes(primary) ? primary : undefined,
    others: allowed.filter((to) => to !== primary),
  };
}

/** Hours and minutes of a span, rounded down to the minute. */
export function hoursAndMinutes(ms: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
