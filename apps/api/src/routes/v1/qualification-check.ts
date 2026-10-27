import {
  calendarDay,
  newGaps,
  QUALIFICATION_OVERRIDE_REASON_MAX,
  type QualificationGap,
  qualificationGaps,
  visitDays,
} from '@integr8/core';
import type { TenantTransaction, Visit } from '@integr8/db';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import type { RequestContext } from '../../http/routes.js';
import type { People } from './operations.js';

/**
 * The qualification check on visits (P26).
 *
 * For each of a job's requirements, at least one person on each of its visits
 * holds that qualification, valid on the visit's days in the company's time
 * zone. Nothing is refused for good: a dispatcher who goes ahead anyway gives a
 * reason, kept with the job (product decision, 2026-10-27).
 *
 * The check runs after a visit is written, inside the same transaction, so it
 * sees exactly what was written — newcomers added to the crew included — and a
 * refusal rolls the whole change back.
 */

/** What a dispatcher sends to go ahead without a required qualification. */
export const qualificationOverrideSchema = z.object({
  reason: z.string().trim().min(1).max(QUALIFICATION_OVERRIDE_REASON_MAX),
});

export interface CompanyClock {
  timeZone: string;
  today: string;
}

export async function companyClock(tx: TenantTransaction, now = new Date()): Promise<CompanyClock> {
  const settings = await tx.settings.get();
  return { timeZone: settings.timezone, today: calendarDay(now, settings.timezone) };
}

type VisitLike = Pick<
  Visit,
  'id' | 'workOrderId' | 'startsAt' | 'endsAt' | 'status' | 'assigneeIds'
>;

/** Each planned visit's gaps, in few queries. Done and cancelled visits have none. */
export async function gapsForVisits(
  tx: TenantTransaction,
  visits: readonly VisitLike[],
  clock?: CompanyClock,
): Promise<Map<string, QualificationGap[]>> {
  const gaps = new Map<string, QualificationGap[]>();
  const planned = visits.filter(
    (visit) => visit.status === 'planned' && visit.assigneeIds.length > 0,
  );
  if (planned.length === 0) {
    return gaps;
  }
  const requirements = await tx.qualifications.workOrderRequirements(
    planned.map((visit) => visit.workOrderId),
  );
  const checked = planned.filter((visit) => (requirements.get(visit.workOrderId) ?? []).length > 0);
  if (checked.length === 0) {
    return gaps;
  }
  const time = clock ?? (await companyClock(tx));
  const holdings = await tx.qualifications.holdings(
    checked.flatMap((visit) => visit.assigneeIds),
    [...requirements.values()].flat().map((requirement) => requirement.qualificationTypeId),
  );
  for (const visit of checked) {
    const found = qualificationGaps({
      requirements: requirements.get(visit.workOrderId) ?? [],
      assigneeIds: visit.assigneeIds,
      holdings,
      days: visitDays(visit, time.timeZone),
      today: time.today,
    });
    if (found.length > 0) {
      gaps.set(visit.id, found);
    }
  }
  return gaps;
}

export async function gapsForVisit(
  tx: TenantTransaction,
  visit: VisitLike,
  clock?: CompanyClock,
): Promise<QualificationGap[]> {
  return (await gapsForVisits(tx, [visit], clock)).get(visit.id) ?? [];
}

const STATUS_WORDS: Record<QualificationGap['people'][number]['status'], string> = {
  missing: 'does not hold it',
  expired: 'holds it expired',
  expires_before_visit: 'holds it, but it expires before the visit',
};

/**
 * The refusal a client answers by asking for a reason: 409 `visit_unqualified`,
 * with a detail per person and requirement so it can say exactly who lacks what.
 */
export function unqualified(gaps: readonly QualificationGap[], people: People): ApiError {
  const names = gaps.map((gap) => gap.name).join(', ');
  return new ApiError(
    409,
    'visit_unqualified',
    `Nobody on this visit holds ${names} for its dates. Give a reason to go ahead anyway.`,
    gaps.flatMap((gap) =>
      gap.people.map((person) => ({
        field: 'body.qualificationOverride',
        code: person.status,
        message: `${people.get(person.userId) ?? 'Someone'} ${STATUS_WORDS[person.status]}: ${gap.name}.`,
        params: {
          qualificationTypeId: gap.qualificationTypeId,
          qualification: gap.name,
          userId: person.userId,
        },
      })),
    ),
  );
}

/**
 * After a visit was written: refuses it when it opened a gap and no reason was
 * given, or records the reason when one was. Gaps the visit already had before
 * the change — a visit already planned anyway, moved again — ask for nothing.
 */
export async function enforceQualifications(
  tx: TenantTransaction,
  context: RequestContext,
  input: {
    before: readonly QualificationGap[];
    visit: Visit;
    reason: string | null | undefined;
    people: People;
    bulk?: boolean;
  },
): Promise<QualificationGap[]> {
  const after = await gapsForVisit(tx, input.visit);
  const opened = newGaps(input.before, after);
  if (opened.length === 0) {
    return after;
  }
  const reason = input.reason?.trim() ?? '';
  if (reason === '') {
    throw unqualified(opened, input.people);
  }
  await tx.qualifications.recordOverride(
    {
      workOrderId: input.visit.workOrderId,
      visitId: input.visit.id,
      reason,
      missing: opened.map((gap) => ({
        qualificationTypeId: gap.qualificationTypeId,
        name: gap.name,
      })),
      assigneeIds: input.visit.assigneeIds,
      startsAt: input.visit.startsAt,
      endsAt: input.visit.endsAt,
    },
    context.principal.userId,
  );
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action: 'work_order.qualification_override',
    resourceType: 'work_order',
    resourceId: input.visit.workOrderId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      visitId: input.visit.id,
      reason,
      missing: opened.map((gap) => gap.qualificationTypeId),
      ...(input.bulk === true ? { bulk: true } : {}),
    },
  });
  return after;
}
