import { z } from 'zod';

/**
 * Visits and the rules of the scheduling board (P25), shared by the API, the
 * desktop calendar and the phone.
 *
 * A job can take several trips. Each trip is a visit: a start, an end, and the
 * people from the job's crew who go. Migration 0051 enforces the same rules for
 * every client; these functions let a screen say what is wrong before it asks.
 */

export const VISIT_STATUSES = ['planned', 'done', 'cancelled'] as const;
export const visitStatusSchema = z.enum(VISIT_STATUSES);
export type VisitStatus = z.infer<typeof visitStatusSchema>;

/** A visit is one trip. Longer work is several visits (`work_order_visits_at_most_a_week`). */
export const VISIT_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Used when a job type gives no expected duration. */
export const DEFAULT_VISIT_DURATION_MINUTES = 60;

/** The calendar snaps starts and ends to this. */
export const VISIT_SNAP_MINUTES = 15;

export interface VisitSlot {
  startsAt: Date;
  endsAt: Date;
}

/** What is wrong with a slot on its own, before anyone is on it. */
export type SlotProblem = 'ends_before_start' | 'too_long';

export function slotProblem(slot: VisitSlot): SlotProblem | undefined {
  const length = slot.endsAt.getTime() - slot.startsAt.getTime();
  if (length <= 0) {
    return 'ends_before_start';
  }
  if (length > VISIT_MAX_DURATION_MS) {
    return 'too_long';
  }
  return undefined;
}

/** Half-open: a visit ending at 10:00 and another starting at 10:00 do not overlap. */
export function slotsOverlap(a: VisitSlot, b: VisitSlot): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

export interface PlannedVisit extends VisitSlot {
  id: string;
  workOrderId: string;
  status: VisitStatus;
  /** The people on the visit now. */
  assigneeIds: readonly string[];
}

export interface DoubleBooking {
  userId: string;
  /** The visit being placed. */
  visitId: string;
  /** The other job's visit it would overlap. */
  conflictingVisitId: string;
  conflictingWorkOrderId: string;
}

/**
 * Where placing `candidate` would put someone on two jobs at once.
 *
 * The same rule as `work_order_visit_assignees_no_double_booking`: only planned
 * visits count, and visits of the same job may overlap.
 */
export function findDoubleBookings(
  candidate: PlannedVisit,
  others: readonly PlannedVisit[],
): DoubleBooking[] {
  if (candidate.status !== 'planned') {
    return [];
  }
  const found: DoubleBooking[] = [];
  for (const other of others) {
    if (
      other.id === candidate.id ||
      other.status !== 'planned' ||
      other.workOrderId === candidate.workOrderId ||
      !slotsOverlap(candidate, other)
    ) {
      continue;
    }
    for (const userId of candidate.assigneeIds) {
      if (other.assigneeIds.includes(userId)) {
        found.push({
          userId,
          visitId: candidate.id,
          conflictingVisitId: other.id,
          conflictingWorkOrderId: other.workOrderId,
        });
      }
    }
  }
  return found;
}

/** Warnings: shown, never blocking. */
export type VisitWarning = 'outside_due_window' | 'no_engineer';

export interface DueWindow {
  dueFrom: Date | null;
  dueBy: Date | null;
}

/**
 * What a dispatcher should notice about a planned visit. Work outside office
 * hours is deliberately not here: companies run 24/7 teams and flexible hours.
 */
export function visitWarnings(
  visit: Pick<PlannedVisit, 'startsAt' | 'endsAt' | 'status' | 'assigneeIds'>,
  job: DueWindow,
): VisitWarning[] {
  if (visit.status !== 'planned') {
    return [];
  }
  const warnings: VisitWarning[] = [];
  if (
    (job.dueFrom !== null && visit.startsAt.getTime() < job.dueFrom.getTime()) ||
    (job.dueBy !== null && visit.endsAt.getTime() > job.dueBy.getTime())
  ) {
    warnings.push('outside_due_window');
  }
  if (visit.assigneeIds.length === 0) {
    warnings.push('no_engineer');
  }
  return warnings;
}

/** Rounds to the nearest snap step, so a drag lands on a quarter hour. */
export function snapToMinutes(at: Date, minutes = VISIT_SNAP_MINUTES): Date {
  const step = minutes * 60 * 1000;
  return new Date(Math.round(at.getTime() / step) * step);
}
