import {
  COVERAGE_REASONS,
  COVERAGE_STATUSES,
  DEADLINE_CLOCKS,
  type DeadlineKind,
  type DeadlineState,
  deadlineState,
  formatAssetReference,
  formatContractReference,
} from '@integr8/core';
import type { JobCoverage, JobDeadline, JobPlan, TenantTransaction } from '@integr8/db';
import { z } from 'zod';

/**
 * What P27 adds to every job: whether a contract covers it, its response and
 * completion deadlines, and the maintenance plans that made it. Kept apart
 * from `operations.ts` so the job summary, the job screen and the phone's
 * copy all read them the same way.
 */

export const DEADLINE_STATES = [
  'met',
  'met_late',
  'missed',
  'warning',
  'running',
  'closed',
] as const;

export const coverageSchema = z.object({
  status: z.enum(COVERAGE_STATUSES),
  /** Why: covered by a contract or a plan's contract, or why not, or `override`. */
  reason: z.enum(COVERAGE_REASONS),
  contract: z.object({ id: z.uuid(), reference: z.string(), title: z.string() }).nullable(),
});

export const coverageDetailSchema = coverageSchema.extend({
  /** Why office staff overrode it, when they did. */
  overrideReason: z.string().nullable(),
  overriddenAt: z.string().nullable(),
});

const oneDeadlineSchema = z.object({
  dueAt: z.string(),
  metAt: z.string().nullable(),
  state: z.enum(DEADLINE_STATES),
  /** When the miss was recorded, if it was. */
  missedAt: z.string().nullable(),
});

/** The deadline that matters now, for a list: the next one open, or the last one missed. */
export const deadlineSummarySchema = z.object({
  kind: z.enum(['response', 'completion']),
  dueAt: z.string(),
  state: z.enum(DEADLINE_STATES),
});

export const deadlinesDetailSchema = z.object({
  priority: z.string(),
  clock: z.enum(DEADLINE_CLOCKS),
  warnMinutes: z.number().int(),
  response: oneDeadlineSchema.nullable(),
  completion: oneDeadlineSchema.nullable(),
});

export const jobPlanSchema = z.object({
  planId: z.uuid(),
  title: z.string(),
  asset: z.object({ id: z.uuid(), name: z.string(), reference: z.string() }),
  /** The day this job was due by the plan, `YYYY-MM-DD`. */
  dueOn: z.string(),
});

export interface JobTerms {
  coverage: Map<string, JobCoverage>;
  deadlines: Map<string, JobDeadline>;
  plans: Map<string, JobPlan[]>;
  contracts: Map<string, { id: string; reference: string; title: string }>;
}

/** Coverage, deadlines and plans for many jobs, in few queries. */
export async function jobTermsOf(
  tx: TenantTransaction,
  workOrderIds: readonly string[],
): Promise<JobTerms> {
  const [coverage, deadlines, plans] = await Promise.all([
    tx.contracts.coverageOf(workOrderIds),
    tx.deadlines.ofJobs(workOrderIds),
    tx.maintenance.plansOfWorkOrders(workOrderIds),
  ]);
  const contractIds = [...coverage.values()]
    .map((entry) => entry.contractId)
    .filter((id): id is string => id !== null);
  const contracts = await tx.contracts.findMany(contractIds);
  return {
    coverage,
    deadlines,
    plans,
    contracts: new Map(
      contracts.map((contract) => [
        contract.id,
        {
          id: contract.id,
          reference: formatContractReference(contract.reference),
          title: contract.title,
        },
      ]),
    ),
  };
}

export function coverageBody(terms: JobTerms, workOrderId: string) {
  const entry = terms.coverage.get(workOrderId);
  if (entry === undefined) {
    return null;
  }
  return {
    status: entry.status,
    reason: entry.reason,
    contract: entry.contractId === null ? null : (terms.contracts.get(entry.contractId) ?? null),
  };
}

export function coverageDetailBody(terms: JobTerms, workOrderId: string) {
  const body = coverageBody(terms, workOrderId);
  const entry = terms.coverage.get(workOrderId);
  if (body === null || entry === undefined) {
    return null;
  }
  return {
    ...body,
    overrideReason: entry.overrideReason,
    overriddenAt: entry.overriddenAt === null ? null : entry.overriddenAt.toISOString(),
  };
}

function oneDeadline(
  dueAt: Date | null,
  metAt: Date | null,
  missedAt: Date | null,
  deadline: JobDeadline,
  now: Date,
) {
  if (dueAt === null) {
    return null;
  }
  return {
    dueAt: dueAt.toISOString(),
    metAt: metAt === null ? null : metAt.toISOString(),
    state: deadlineState({
      dueAt,
      metAt,
      closedAt: deadline.closedAt,
      warnMinutes: deadline.warnMinutes,
      now,
    }),
    missedAt: missedAt === null ? null : missedAt.toISOString(),
  };
}

export function deadlinesDetailBody(terms: JobTerms, workOrderId: string, now = new Date()) {
  const deadline = terms.deadlines.get(workOrderId);
  if (deadline === undefined) {
    return null;
  }
  return {
    priority: deadline.priority,
    clock: deadline.clock,
    warnMinutes: deadline.warnMinutes,
    response: oneDeadline(
      deadline.responseDueAt,
      deadline.respondedAt,
      deadline.responseMissedAt,
      deadline,
      now,
    ),
    completion: oneDeadline(
      deadline.completionDueAt,
      deadline.completedAt,
      deadline.completionMissedAt,
      deadline,
      now,
    ),
  };
}

const OPEN: readonly DeadlineState[] = ['warning', 'running'];

export function deadlineSummaryBody(terms: JobTerms, workOrderId: string, now = new Date()) {
  const detail = deadlinesDetailBody(terms, workOrderId, now);
  if (detail === null) {
    return null;
  }
  const entries: { kind: DeadlineKind; dueAt: string; state: DeadlineState }[] = [];
  if (detail.response !== null) {
    entries.push({ kind: 'response', dueAt: detail.response.dueAt, state: detail.response.state });
  }
  if (detail.completion !== null) {
    entries.push({
      kind: 'completion',
      dueAt: detail.completion.dueAt,
      state: detail.completion.state,
    });
  }
  const open = entries.find((entry) => OPEN.includes(entry.state));
  if (open !== undefined) {
    return open;
  }
  const missed = [...entries]
    .reverse()
    .find((entry) => entry.state === 'missed' || entry.state === 'met_late');
  return missed ?? null;
}

export async function jobPlanBodies(
  tx: TenantTransaction,
  terms: JobTerms,
  workOrderId: string,
): Promise<z.infer<typeof jobPlanSchema>[]> {
  const plans = terms.plans.get(workOrderId) ?? [];
  if (plans.length === 0) {
    return [];
  }
  const found = await tx.maintenance.findPlans(plans.map((plan) => plan.planId));
  const byId = new Map(found.map((plan) => [plan.id, plan]));
  return plans.map((plan) => {
    const full = byId.get(plan.planId);
    return {
      planId: plan.planId,
      title: plan.title,
      asset: {
        id: plan.assetId,
        name: full?.assetName ?? '',
        reference: full === undefined ? '' : formatAssetReference(full.assetReference),
      },
      dueOn: plan.dueOn,
    };
  });
}
