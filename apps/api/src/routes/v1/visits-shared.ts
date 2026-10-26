import {
  type DueWindow,
  type QualificationGap,
  VISIT_STATUSES,
  visitWarnings,
} from '@integr8/core';
import type { Visit, VisitRefusal } from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { type People, personBody, personSchema } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

export const holdingProblemSchema = z.enum(['expires_before_visit', 'expired', 'missing']);

/** A job's requirement nobody on a visit meets (P26). */
export const qualificationGapSchema = z.object({
  qualificationTypeId: z.uuid(),
  name: z.string(),
  /** Everyone on the visit, and why none of them counts. */
  people: z.array(personSchema.extend({ status: holdingProblemSchema })),
});

export function gapBodies(gaps: readonly QualificationGap[], people: People) {
  return gaps.map((gap) => ({
    qualificationTypeId: gap.qualificationTypeId,
    name: gap.name,
    people: gap.people.map((person) => ({
      id: person.userId,
      name: people.get(person.userId) ?? '',
      status: person.status,
    })),
  }));
}

/**
 * A visit as every client sees it (P25): on the scheduling board, on the job
 * screen and on the engineer's phone.
 */
export const visitSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(VISIT_STATUSES),
  notes: z.string().nullable(),
  assignees: z.array(personSchema),
  completedAt: z.string().nullable(),
  completedBy: personSchema.nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  revision: z.number().int(),
  /**
   * Worth a dispatcher's notice, never blocking. Working hours are deliberately
   * not one. `unqualified`: nobody on it holds something the job needs (P26).
   */
  warnings: z.array(z.enum(['outside_due_window', 'no_engineer', 'unqualified'])),
  /** The job's requirements nobody on this planned visit meets, as of today (P26). */
  qualificationGaps: z.array(qualificationGapSchema),
});

export type VisitBody = z.infer<typeof visitSchema>;

export function visitBody(
  visit: Visit,
  job: DueWindow,
  people: People,
  gaps: readonly QualificationGap[] = [],
): VisitBody {
  return {
    id: visit.id,
    workOrderId: visit.workOrderId,
    startsAt: iso(visit.startsAt),
    endsAt: iso(visit.endsAt),
    status: visit.status,
    notes: visit.notes,
    assignees: visit.assigneeIds.map((userId) => personBody(userId, people)),
    completedAt: isoOrNull(visit.completedAt),
    completedBy: visit.completedBy === null ? null : personBody(visit.completedBy, people),
    cancelledAt: isoOrNull(visit.cancelledAt),
    cancelReason: visit.cancelReason,
    revision: visit.revision,
    warnings: [
      ...visitWarnings(visit, job),
      ...(gaps.length > 0 ? (['unqualified'] as const) : []),
    ],
    qualificationGaps: gapBodies(gaps, people),
  };
}

/** A repository refusal, as the API says it. */
export function visitRefusal(result: VisitRefusal, people: People): never {
  switch (result.outcome) {
    case 'not_found':
      throw notFound('This visit does not exist.');
    case 'job_not_found':
      throw notFound('This work order does not exist.');
    case 'job_closed':
      throw conflict(
        'work_order_closed',
        `This job is ${result.state.replace('_', ' ')}; it cannot have planned visits.`,
      );
    case 'conflict':
      throw conflict(
        'visit_changed',
        'This visit was changed elsewhere since you loaded it. Reload and try again.',
      );
    case 'final':
      throw conflict(
        'visit_final',
        `This visit is ${result.current.status}; it can no longer change.`,
      );
    case 'invalid_slot':
      throw unprocessable(
        'visit_slot_invalid',
        result.problem === 'too_long'
          ? 'A visit lasts at most a week. Plan longer work as several visits.'
          : 'A visit must end after it starts.',
        [{ field: 'body.endsAt', code: result.problem, message: 'Choose a later end.' }],
      );
    case 'not_on_crew':
      throw unprocessable(
        'visit_assignee_not_on_crew',
        'Only people on the job’s crew can go on its visits. Add them to the crew first.',
        result.userIds.map((userId) => ({
          field: 'body.assigneeIds',
          code: 'not_on_crew',
          message: `${people.get(userId) ?? 'This person'} is not on the crew.`,
          params: { userId },
        })),
      );
    case 'double_booked': {
      const names = [...new Set(result.conflicts.map((clash) => people.get(clash.userId) ?? ''))]
        .filter((name) => name !== '')
        .join(', ');
      throw new ApiError(
        409,
        'visit_double_booked',
        names === ''
          ? 'Someone on this visit is already on another job at that time.'
          : `${names} ${names.includes(',') ? 'are' : 'is'} already on another job at that time.`,
        result.conflicts.map((clash) => ({
          field: 'body.assigneeIds',
          code: 'double_booked',
          message: `${people.get(clash.userId) ?? 'Someone'} is on another visit then.`,
          params: {
            userId: clash.userId,
            visitId: clash.conflictingVisitId,
            workOrderId: clash.conflictingWorkOrderId,
          },
        })),
      );
    }
  }
}
