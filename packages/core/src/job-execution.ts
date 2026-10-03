import type { WorkOrderState } from './work-orders.js';

/**
 * Running a job, as rules every client and the server agree on (P14): what a job
 * still needs before it can be completed, and how long was spent travelling,
 * on site and working, from its history.
 *
 * The database enforces completion itself (migration 0013); this is what lets a
 * phone say exactly what is missing before it tries, in the same terms.
 */

export interface CompletionFacts {
  forms: readonly { formId: string; title: string; required: boolean; submitted: boolean }[];
  photos: {
    before: { needed: number; taken: number };
    after: { needed: number; taken: number };
  };
  signoff: { required: boolean; recorded: boolean };
}

export interface CompletionMissing {
  /** Required forms not yet submitted, in the job's order. */
  forms: { formId: string; title: string }[];
  /** How many more photos of each kind are needed. */
  beforePhotos: number;
  afterPhotos: number;
  /** The customer's sign-off is required and not yet recorded. */
  signoff: boolean;
}

export function completionMissing(facts: CompletionFacts): CompletionMissing {
  return {
    forms: facts.forms
      .filter((form) => form.required && !form.submitted)
      .map(({ formId, title }) => ({ formId, title })),
    beforePhotos: Math.max(0, facts.photos.before.needed - facts.photos.before.taken),
    afterPhotos: Math.max(0, facts.photos.after.needed - facts.photos.after.taken),
    signoff: facts.signoff.required && !facts.signoff.recorded,
  };
}

export function canComplete(missing: CompletionMissing): boolean {
  return (
    missing.forms.length === 0 &&
    missing.beforePhotos === 0 &&
    missing.afterPhotos === 0 &&
    !missing.signoff
  );
}

export interface StateChange {
  fromState: WorkOrderState;
  toState: WorkOrderState;
  /** When it happened — for a change made offline, when the phone recorded it. */
  occurredAt: Date | string;
}

export interface JobTimes {
  /** Time in `travelling`. */
  travelMs: number;
  /** Time in `on_site` — arrived, not yet working. */
  onSiteMs: number;
  /** Time in `in_progress`. */
  workMs: number;
  /** Time in `awaiting_parts`. */
  waitingMs: number;
  /** The first time each happened, if it has. */
  travelledAt: Date | undefined;
  arrivedAt: Date | undefined;
  startedAt: Date | undefined;
  completedAt: Date | undefined;
}

const COUNTED: Partial<Record<WorkOrderState, 'travelMs' | 'onSiteMs' | 'workMs' | 'waitingMs'>> = {
  travelling: 'travelMs',
  on_site: 'onSiteMs',
  in_progress: 'workMs',
  awaiting_parts: 'waitingMs',
};

/**
 * Time spent on a job, from its state changes in order. The state it is in now
 * counts up to `now` when one is given, so a job being worked shows its time so
 * far; without `now`, only finished stretches count.
 */
export function jobTimes(changes: readonly StateChange[], now?: Date): JobTimes {
  const times: JobTimes = {
    travelMs: 0,
    onSiteMs: 0,
    workMs: 0,
    waitingMs: 0,
    travelledAt: undefined,
    arrivedAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
  };
  const ordered = changes
    .map((change) => ({ ...change, at: new Date(change.occurredAt) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  ordered.forEach((change, index) => {
    const next = ordered[index + 1];
    const end = next?.at ?? now;
    const bucket = COUNTED[change.toState];
    if (bucket !== undefined && end !== undefined) {
      times[bucket] += Math.max(0, end.getTime() - change.at.getTime());
    }
    if (change.toState === 'travelling') {
      times.travelledAt ??= change.at;
    } else if (change.toState === 'on_site') {
      times.arrivedAt ??= change.at;
    } else if (change.toState === 'in_progress') {
      times.startedAt ??= change.at;
    } else if (change.toState === 'complete') {
      times.completedAt = change.at;
    }
  });
  return times;
}

export interface ShiftSpan {
  startedAt: Date | string;
  endedAt: Date | string | null;
}

/** How long a shift has lasted: to its end, or to `now` while it is open. */
export function shiftDurationMs(shift: ShiftSpan, now: Date): number {
  const start = new Date(shift.startedAt).getTime();
  const end = shift.endedAt === null ? now.getTime() : new Date(shift.endedAt).getTime();
  return Math.max(0, end - start);
}
