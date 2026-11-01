import {
  type AssetStatus,
  type IntervalUnit,
  type NextDue,
  type OccurrenceSkipReason,
  type OccurrenceStatus,
  type PlanCounting,
  type PlanStatus,
  toUserId,
  type UserId,
  type WorkOrderState,
} from '@integr8/core';
import { sql } from 'kysely';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/** Recurring servicing of one asset (P27, migration 0053). Dates are `YYYY-MM-DD`. */
export interface MaintenancePlan {
  id: string;
  assetId: string;
  /** The asset's customer and site, which the plan's jobs are for. */
  customerId: string;
  siteId: string;
  assetName: string;
  assetReference: number;
  assetStatus: AssetStatus;
  jobTypeId: string;
  contractId: string | null;
  title: string;
  instructions: string | null;
  intervalCount: number;
  intervalUnit: IntervalUnit;
  counting: PlanCounting;
  startsOn: string;
  endsOn: string | null;
  windowBeforeDays: number;
  windowAfterDays: number;
  leadDays: number;
  canShare: boolean;
  status: PlanStatus;
  nextDueOn: string | null;
  nextSequence: number;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  endedBy: UserId | null;
  /**
   * Why the worker last failed to make this plan's jobs, when, and how many
   * times in a row (0063); null and 0 once it succeeds or the plan is edited.
   */
  lastError: string | null;
  lastErrorAt: Date | null;
  failureCount: number;
}

export interface MaintenancePlanInput {
  assetId: string;
  jobTypeId: string;
  contractId?: string | null | undefined;
  title: string;
  instructions?: string | null | undefined;
  intervalCount: number;
  intervalUnit: IntervalUnit;
  counting: PlanCounting;
  startsOn: string;
  endsOn?: string | null | undefined;
  windowBeforeDays?: number | undefined;
  windowAfterDays?: number | undefined;
  leadDays?: number | undefined;
  canShare?: boolean | undefined;
}

export type MaintenancePlanChanges = {
  [K in keyof Omit<MaintenancePlanInput, 'assetId'>]?: MaintenancePlanInput[K] | undefined;
};

export type MaintenancePlanWrite =
  | { outcome: 'written'; plan: MaintenancePlan }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; current: MaintenancePlan }
  | { outcome: 'ended'; current: MaintenancePlan };

/** A plan's last due date, and what became of it. */
export interface LastOccurrence {
  planId: string;
  dueOn: string;
  status: OccurrenceStatus;
  workOrderId: string | null;
  jobState: WorkOrderState | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

/** An active plan whose next job is due to be made, with what decides whether it can be. */
export interface DuePlan {
  plan: MaintenancePlan;
  contractEndsOn: string | null;
  contractCancelledOn: string | null;
}

/** One due date, made or passed over, for the maintenance screen. */
export interface OccurrenceRow {
  id: string;
  planId: string;
  planTitle: string;
  assetId: string;
  assetName: string;
  assetReference: number;
  customerId: string;
  siteId: string;
  jobTypeId: string;
  dueOn: string;
  status: OccurrenceStatus;
  skipReason: OccurrenceSkipReason | null;
  workOrderId: string | null;
  workOrderReference: number | null;
  jobState: WorkOrderState | null;
  dueBy: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/** What a job knows of the plans that made it. */
export interface JobPlan {
  planId: string;
  title: string;
  assetId: string;
  dueOn: string;
}

export interface PlanQuery {
  assetId?: string;
  customerId?: string;
  siteId?: string;
  jobTypeId?: string;
  contractId?: string;
  includeEnded?: boolean;
  /** Only plans the worker last failed on (0063). */
  failing?: boolean;
}

export interface OccurrenceQuery {
  from: string;
  to: string;
  customerId?: string;
  siteId?: string;
  jobTypeId?: string;
  assetId?: string;
  limit?: number;
}

function blank(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Maintenance plans for one company (P27).
 *
 * The due dates are counted in `@integr8/core` and handed in here; this class
 * stores them. Making jobs is the worker's (`apps/api/src/maintenance`), which
 * reads `dueForCreation`, makes or joins a job, and records the occurrence —
 * unique per plan and date, so running twice makes nothing twice.
 */
export class MaintenanceRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #plans() {
    return this.db
      .selectFrom('maintenance_plans as p')
      .innerJoin('erp_assets as a', (join) =>
        join.onRef('a.tenant_id', '=', 'p.tenant_id').onRef('a.id', '=', 'p.asset_id'),
      )
      .select([
        'p.id',
        'p.asset_id',
        'a.customer_id',
        'a.site_id',
        'a.name as asset_name',
        'a.reference as asset_reference',
        'a.status as asset_status',
        'p.job_type_id',
        'p.contract_id',
        'p.title',
        'p.instructions',
        'p.interval_count',
        'p.interval_unit',
        'p.counting',
        sql<string>`p.starts_on::text`.as('starts_on'),
        sql<string | null>`p.ends_on::text`.as('ends_on'),
        'p.window_before_days',
        'p.window_after_days',
        'p.lead_days',
        'p.can_share',
        'p.status',
        sql<string | null>`p.next_due_on::text`.as('next_due_on'),
        'p.next_sequence',
        'p.version',
        'p.created_by',
        'p.created_at',
        'p.updated_at',
        'p.ended_at',
        'p.ended_by',
        'p.last_error',
        'p.last_error_at',
        'p.failure_count',
      ])
      .where('p.tenant_id', '=', this.tenantId);
  }

  /** The base query, exposed for its row type only. */
  plansQuery() {
    return this.#plans();
  }

  async listPlans(query: PlanQuery = {}): Promise<MaintenancePlan[]> {
    let select = this.#plans();
    if (query.assetId !== undefined) {
      select = select.where('p.asset_id', '=', query.assetId);
    }
    if (query.customerId !== undefined) {
      select = select.where('a.customer_id', '=', query.customerId);
    }
    if (query.siteId !== undefined) {
      select = select.where('a.site_id', '=', query.siteId);
    }
    if (query.jobTypeId !== undefined) {
      select = select.where('p.job_type_id', '=', query.jobTypeId);
    }
    if (query.contractId !== undefined) {
      select = select.where('p.contract_id', '=', query.contractId);
    }
    if (query.includeEnded !== true) {
      select = select.where('p.status', '<>', 'ended');
    }
    if (query.failing === true) {
      select = select.where('p.last_error', 'is not', null);
    }
    const rows = await select.orderBy('p.next_due_on').orderBy('p.title').orderBy('p.id').execute();
    return rows.map(toPlan);
  }

  async findPlans(planIds: readonly string[]): Promise<MaintenancePlan[]> {
    if (planIds.length === 0) {
      return [];
    }
    const rows = await this.#plans()
      .where('p.id', 'in', [...new Set(planIds)])
      .execute();
    return rows.map(toPlan);
  }

  async findPlan(planId: string): Promise<MaintenancePlan | undefined> {
    return (await this.findPlans([planId]))[0];
  }

  async createPlan(
    input: MaintenancePlanInput,
    next: NextDue,
    actor: UserId | string,
  ): Promise<MaintenancePlan> {
    const row = await this.db
      .insertInto('maintenance_plans')
      .values({
        tenant_id: this.tenantId,
        asset_id: input.assetId,
        job_type_id: input.jobTypeId,
        contract_id: input.contractId ?? null,
        title: input.title.trim(),
        instructions: blank(input.instructions) ?? null,
        interval_count: input.intervalCount,
        interval_unit: input.intervalUnit,
        counting: input.counting,
        starts_on: input.startsOn,
        ends_on: input.endsOn ?? null,
        ...(input.windowBeforeDays === undefined
          ? {}
          : { window_before_days: input.windowBeforeDays }),
        ...(input.windowAfterDays === undefined
          ? {}
          : { window_after_days: input.windowAfterDays }),
        ...(input.leadDays === undefined ? {} : { lead_days: input.leadDays }),
        ...(input.canShare === undefined ? {} : { can_share: input.canShare }),
        next_due_on: next.nextDueOn,
        next_sequence: next.nextSequence,
        created_by: toUserId(actor),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return (await this.findPlan(row.id))!;
  }

  /**
   * Changes a plan. `next` is where it goes from here, worked out by the caller
   * from the changed plan and its last occurrence; jobs already made are left
   * alone.
   */
  async updatePlan(
    planId: string,
    expectedVersion: number,
    changes: MaintenancePlanChanges,
    next: NextDue | undefined,
  ): Promise<MaintenancePlanWrite> {
    const current = await this.findPlan(planId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.status === 'ended') {
      return { outcome: 'ended', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    const instructions = blank(changes.instructions);
    const row = await this.db
      .updateTable('maintenance_plans')
      .set({
        ...(changes.jobTypeId === undefined ? {} : { job_type_id: changes.jobTypeId }),
        ...(changes.contractId === undefined ? {} : { contract_id: changes.contractId }),
        ...(changes.title === undefined ? {} : { title: changes.title.trim() }),
        ...(instructions === undefined ? {} : { instructions }),
        ...(changes.intervalCount === undefined ? {} : { interval_count: changes.intervalCount }),
        ...(changes.intervalUnit === undefined ? {} : { interval_unit: changes.intervalUnit }),
        ...(changes.counting === undefined ? {} : { counting: changes.counting }),
        ...(changes.startsOn === undefined ? {} : { starts_on: changes.startsOn }),
        ...(changes.endsOn === undefined ? {} : { ends_on: changes.endsOn }),
        ...(changes.windowBeforeDays === undefined
          ? {}
          : { window_before_days: changes.windowBeforeDays }),
        ...(changes.windowAfterDays === undefined
          ? {}
          : { window_after_days: changes.windowAfterDays }),
        ...(changes.leadDays === undefined ? {} : { lead_days: changes.leadDays }),
        ...(changes.canShare === undefined ? {} : { can_share: changes.canShare }),
        ...(next === undefined
          ? {}
          : { next_due_on: next.nextDueOn, next_sequence: next.nextSequence }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', planId)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (row === undefined) {
      const latest = await this.findPlan(planId);
      return latest === undefined
        ? { outcome: 'not_found' }
        : { outcome: 'conflict', current: latest };
    }
    return { outcome: 'written', plan: (await this.findPlan(planId))! };
  }

  /** Pauses, resumes or ends a plan. Ending is final. */
  async setStatus(
    planId: string,
    expectedVersion: number,
    status: PlanStatus,
    actor: UserId | string,
    next?: NextDue,
  ): Promise<MaintenancePlanWrite> {
    const current = await this.findPlan(planId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.status === 'ended') {
      return { outcome: 'ended', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    const row = await this.db
      .updateTable('maintenance_plans')
      .set({
        status,
        ...(status === 'ended' ? { ended_at: sql<Date>`now()`, ended_by: toUserId(actor) } : {}),
        ...(next === undefined
          ? {}
          : { next_due_on: next.nextDueOn, next_sequence: next.nextSequence }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', planId)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (row === undefined) {
      const latest = await this.findPlan(planId);
      return latest === undefined
        ? { outcome: 'not_found' }
        : { outcome: 'conflict', current: latest };
    }
    return { outcome: 'written', plan: (await this.findPlan(planId))! };
  }

  /**
   * Runs `fn` in a savepoint: when it throws, what it wrote is rolled back and
   * the transaction stays usable, so one plan's failure is that plan's alone.
   */
  async isolated<T>(fn: () => Promise<T>): Promise<T> {
    await sql`savepoint maintenance_plan`.execute(this.db);
    try {
      const result = await fn();
      await sql`release savepoint maintenance_plan`.execute(this.db);
      return result;
    } catch (error) {
      await sql`rollback to savepoint maintenance_plan`.execute(this.db);
      throw error;
    }
  }

  /** The worker could not make a plan's jobs: why, now, and one more in a row (0063). */
  async recordFailure(planId: string, message: string): Promise<void> {
    await this.db
      .updateTable('maintenance_plans')
      .set({
        last_error: message.slice(0, 2000),
        last_error_at: sql<Date>`now()`,
        failure_count: sql<number>`failure_count + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', planId)
      .where('status', '<>', 'ended')
      .execute();
  }

  /** The worker made a plan's jobs: any earlier failure is over. */
  async clearFailure(planId: string): Promise<void> {
    await this.db
      .updateTable('maintenance_plans')
      .set({ last_error: null, last_error_at: null, failure_count: 0 })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', planId)
      .where('failure_count', '>', 0)
      .where('status', '<>', 'ended')
      .execute();
  }

  /** The worker moves a plan on to its next due date. */
  async advance(planId: string, next: NextDue): Promise<void> {
    await this.db
      .updateTable('maintenance_plans')
      .set({ next_due_on: next.nextDueOn, next_sequence: next.nextSequence })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', planId)
      .where('status', '<>', 'ended')
      .execute();
  }

  /** Each plan's latest occurrence, with its job's state. */
  async lastOccurrences(planIds: readonly string[]): Promise<Map<string, LastOccurrence>> {
    if (planIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('maintenance_occurrences as o')
      .leftJoin('work_orders as w', (join) =>
        join.onRef('w.tenant_id', '=', 'o.tenant_id').onRef('w.id', '=', 'o.work_order_id'),
      )
      .distinctOn('o.plan_id')
      .select([
        'o.plan_id',
        sql<string>`o.due_on::text`.as('due_on'),
        'o.status',
        'o.work_order_id',
        'w.state',
        'w.completed_at',
        'w.cancelled_at',
      ])
      .where('o.tenant_id', '=', this.tenantId)
      .where('o.plan_id', 'in', [...new Set(planIds)])
      .orderBy('o.plan_id')
      .orderBy('o.due_on', 'desc')
      .execute();
    return new Map(
      rows.map((row) => [
        row.plan_id,
        {
          planId: row.plan_id,
          dueOn: row.due_on,
          status: row.status,
          workOrderId: row.work_order_id,
          jobState: row.state ?? null,
          completedAt: row.completed_at ?? null,
          cancelledAt: row.cancelled_at ?? null,
        },
      ]),
    );
  }

  /** Active plans whose next job should exist by `today`. */
  async dueForCreation(today: string): Promise<DuePlan[]> {
    const rows = await this.#plans()
      .leftJoin('service_contracts as c', (join) =>
        join.onRef('c.tenant_id', '=', 'p.tenant_id').onRef('c.id', '=', 'p.contract_id'),
      )
      .select([
        sql<string | null>`c.ends_on::text`.as('contract_ends_on'),
        sql<string | null>`c.cancelled_on::text`.as('contract_cancelled_on'),
      ])
      .where('p.status', '=', 'active')
      .where('p.next_due_on', 'is not', null)
      .where(sql<boolean>`p.next_due_on - p.lead_days <= ${today}::date`)
      .orderBy('p.next_due_on')
      .orderBy('p.id')
      .execute();
    return rows.map((row) => ({
      plan: toPlan(row),
      contractEndsOn: row.contract_ends_on,
      contractCancelledOn: row.contract_cancelled_on,
    }));
  }

  /** Active completion plans waiting on their last job. */
  async waitingOnCompletion(): Promise<MaintenancePlan[]> {
    const rows = await this.#plans()
      .where('p.status', '=', 'active')
      .where('p.counting', '=', 'completion')
      .where('p.next_due_on', 'is', null)
      .execute();
    return rows.map(toPlan);
  }

  /**
   * Records what became of a due date. False when it was already recorded — by
   * an earlier run, or a worker running at the same time.
   */
  async recordOccurrence(input: {
    planId: string;
    dueOn: string;
    workOrderId: string | null;
    skipReason?: OccurrenceSkipReason;
  }): Promise<boolean> {
    const row = await this.db
      .insertInto('maintenance_occurrences')
      .values({
        tenant_id: this.tenantId,
        plan_id: input.planId,
        due_on: input.dueOn,
        work_order_id: input.workOrderId,
        status: input.workOrderId === null ? 'skipped' : 'created',
        skip_reason: input.workOrderId === null ? (input.skipReason ?? 'plan_ended') : null,
      })
      .onConflict((conflict) => conflict.columns(['tenant_id', 'plan_id', 'due_on']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Whether a plan already has an occurrence for a date. */
  async hasOccurrence(planId: string, dueOn: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('maintenance_occurrences')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('plan_id', '=', planId)
      .where('due_on', '=', dueOn)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * A job another plan already made that a sharing plan can join: same site,
   * job type and contract, still unplanned (not dispatched, no planned visit),
   * made only by plans that share, with a due window that meets `window`.
   */
  async joinableJob(input: {
    siteId: string;
    jobTypeId: string;
    contractId: string | null;
    window: { from: string; to: string };
    timeZone: string;
  }): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('work_orders as w')
      .select('w.id')
      .where('w.tenant_id', '=', this.tenantId)
      .where('w.site_id', '=', input.siteId)
      .where('w.job_type_id', '=', input.jobTypeId)
      .where('w.state', '=', 'scheduled')
      .where('w.due_from', 'is not', null)
      .where('w.due_by', 'is not', null)
      .where(
        sql<boolean>`(w.due_from at time zone ${input.timeZone})::date <= ${input.window.to}::date`,
      )
      .where(
        sql<boolean>`(w.due_by at time zone ${input.timeZone})::date >= ${input.window.from}::date`,
      )
      .where(
        sql<boolean>`exists (
        select 1 from maintenance_occurrences o
          join maintenance_plans p on p.tenant_id = o.tenant_id and p.id = o.plan_id
         where o.tenant_id = w.tenant_id and o.work_order_id = w.id
           and p.contract_id is not distinct from ${input.contractId}::uuid)`,
      )
      .where(
        sql<boolean>`not exists (
        select 1 from maintenance_occurrences o
          join maintenance_plans p on p.tenant_id = o.tenant_id and p.id = o.plan_id
         where o.tenant_id = w.tenant_id and o.work_order_id = w.id
           and (not p.can_share or p.contract_id is distinct from ${input.contractId}::uuid))`,
      )
      .where(
        sql<boolean>`not exists (
        select 1 from work_order_visits v
         where v.tenant_id = w.tenant_id and v.work_order_id = w.id and v.status = 'planned')`,
      )
      .orderBy('w.due_from')
      .orderBy('w.id')
      .executeTakeFirst();
    return row?.id;
  }

  /** What the plans that made each job say about it. */
  async plansOfWorkOrders(workOrderIds: readonly string[]): Promise<Map<string, JobPlan[]>> {
    if (workOrderIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('maintenance_occurrences as o')
      .innerJoin('maintenance_plans as p', (join) =>
        join.onRef('p.tenant_id', '=', 'o.tenant_id').onRef('p.id', '=', 'o.plan_id'),
      )
      .select([
        'o.work_order_id',
        'p.id',
        'p.title',
        'p.asset_id',
        sql<string>`o.due_on::text`.as('due_on'),
      ])
      .where('o.tenant_id', '=', this.tenantId)
      .where('o.work_order_id', 'in', [...new Set(workOrderIds)])
      .orderBy('o.due_on')
      .orderBy('p.title')
      .execute();
    const map = new Map<string, JobPlan[]>();
    for (const row of rows) {
      const list = map.get(row.work_order_id!) ?? [];
      list.push({ planId: row.id, title: row.title, assetId: row.asset_id, dueOn: row.due_on });
      map.set(row.work_order_id!, list);
    }
    return map;
  }

  /** Due dates made or passed over between two days, for the maintenance screen. */
  async listOccurrences(query: OccurrenceQuery): Promise<OccurrenceRow[]> {
    let select = this.db
      .selectFrom('maintenance_occurrences as o')
      .innerJoin('maintenance_plans as p', (join) =>
        join.onRef('p.tenant_id', '=', 'o.tenant_id').onRef('p.id', '=', 'o.plan_id'),
      )
      .innerJoin('erp_assets as a', (join) =>
        join.onRef('a.tenant_id', '=', 'p.tenant_id').onRef('a.id', '=', 'p.asset_id'),
      )
      .leftJoin('work_orders as w', (join) =>
        join.onRef('w.tenant_id', '=', 'o.tenant_id').onRef('w.id', '=', 'o.work_order_id'),
      )
      .select([
        'o.id',
        'o.plan_id',
        'p.title as plan_title',
        'p.asset_id',
        'a.name as asset_name',
        'a.reference as asset_reference',
        'a.customer_id',
        'a.site_id',
        'p.job_type_id',
        sql<string>`o.due_on::text`.as('due_on'),
        'o.status',
        'o.skip_reason',
        'o.work_order_id',
        'w.reference as work_order_reference',
        'w.state',
        'w.due_by',
        'w.completed_at',
        'o.created_at',
      ])
      .where('o.tenant_id', '=', this.tenantId)
      .where(sql<boolean>`o.due_on between ${query.from}::date and ${query.to}::date`);
    if (query.customerId !== undefined) {
      select = select.where('a.customer_id', '=', query.customerId);
    }
    if (query.siteId !== undefined) {
      select = select.where('a.site_id', '=', query.siteId);
    }
    if (query.jobTypeId !== undefined) {
      select = select.where('p.job_type_id', '=', query.jobTypeId);
    }
    if (query.assetId !== undefined) {
      select = select.where('p.asset_id', '=', query.assetId);
    }
    const rows = await select
      .orderBy('o.due_on')
      .orderBy('p.title')
      .limit(query.limit ?? 500)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      planTitle: row.plan_title,
      assetId: row.asset_id,
      assetName: row.asset_name,
      assetReference: row.asset_reference,
      customerId: row.customer_id,
      siteId: row.site_id,
      jobTypeId: row.job_type_id,
      dueOn: row.due_on,
      status: row.status,
      skipReason: row.skip_reason,
      workOrderId: row.work_order_id,
      workOrderReference: row.work_order_reference ?? null,
      jobState: row.state ?? null,
      dueBy: row.due_by ?? null,
      completedAt: row.completed_at ?? null,
      createdAt: row.created_at,
    }));
  }
}

type PlanRow = Awaited<
  ReturnType<ReturnType<MaintenanceRepository['plansQuery']>['execute']>
>[number];

function toPlan(row: PlanRow): MaintenancePlan {
  return {
    id: row.id,
    assetId: row.asset_id,
    customerId: row.customer_id,
    siteId: row.site_id,
    assetName: row.asset_name,
    assetReference: row.asset_reference,
    assetStatus: row.asset_status,
    jobTypeId: row.job_type_id,
    contractId: row.contract_id,
    title: row.title,
    instructions: row.instructions,
    intervalCount: row.interval_count,
    intervalUnit: row.interval_unit,
    counting: row.counting,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    windowBeforeDays: row.window_before_days,
    windowAfterDays: row.window_after_days,
    leadDays: row.lead_days,
    canShare: row.can_share,
    status: row.status,
    nextDueOn: row.next_due_on,
    nextSequence: row.next_sequence,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    endedBy: row.ended_by === null ? null : toUserId(row.ended_by),
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    failureCount: row.failure_count,
  };
}
