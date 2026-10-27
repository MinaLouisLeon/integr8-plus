import {
  type DeadlineClock,
  type DeadlineKind,
  type DeadlineRule,
  deadlinesFor,
  toUserId,
  type UserId,
  type WorkingHours,
  type WorkOrderPriority,
  type WorkOrderState,
} from '@integr8/core';
import { sql } from 'kysely';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/** One job's deadlines as stored (P27, migration 0053). */
export interface JobDeadline {
  workOrderId: string;
  priority: WorkOrderPriority;
  clock: DeadlineClock;
  warnMinutes: number;
  responseDueAt: Date | null;
  completionDueAt: Date | null;
  respondedAt: Date | null;
  completedAt: Date | null;
  responseMissedAt: Date | null;
  completionMissedAt: Date | null;
  closedAt: Date | null;
}

/** A deadline the worker has something to say about. */
export interface DeadlineNotice {
  workOrderId: string;
  kind: DeadlineKind;
  dueAt: Date;
  priority: WorkOrderPriority;
}

/** One job in the deadlines report. */
export interface DeadlineReportRow extends JobDeadline {
  reference: number;
  title: string;
  customerId: string;
  state: WorkOrderState;
  createdAt: Date;
}

export interface StoredDeadlineRule extends DeadlineRule {
  version: number;
  updatedBy: UserId;
  updatedAt: Date;
}

/**
 * Response deadlines for one company (P27).
 *
 * Migration 0053 keeps the parts every client must agree on: a job's own state
 * changes meet its deadlines, a deadline met late is a miss, a recorded miss is
 * never cleared and is written into the job's history. This class works out
 * the deadlines (with `@integr8/core`) and hands the worker what is due.
 */
export class DeadlinesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async listRules(): Promise<StoredDeadlineRule[]> {
    const rows = await this.db
      .selectFrom('deadline_rules')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .execute();
    const order = ['urgent', 'high', 'normal', 'low'];
    return rows
      .map((row) => ({
        priority: row.priority,
        responseMinutes: row.response_minutes,
        completionMinutes: row.completion_minutes,
        clock: row.clock,
        warnMinutes: row.warn_minutes,
        version: row.version,
        updatedBy: toUserId(row.updated_by),
        updatedAt: row.updated_at,
      }))
      .sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));
  }

  /**
   * Replaces the company's rules. A priority left out has no deadlines. Jobs
   * already created keep the deadlines they were given.
   */
  async replaceRules(
    rules: readonly DeadlineRule[],
    actor: UserId | string,
  ): Promise<StoredDeadlineRule[]> {
    const priorities = rules.map((rule) => rule.priority);
    let remove = this.db.deleteFrom('deadline_rules').where('tenant_id', '=', this.tenantId);
    if (priorities.length > 0) {
      remove = remove.where('priority', 'not in', priorities);
    }
    await remove.execute();
    for (const rule of rules) {
      const values = {
        response_minutes: rule.responseMinutes,
        completion_minutes: rule.completionMinutes,
        clock: rule.clock,
        warn_minutes: rule.warnMinutes,
        updated_by: toUserId(actor),
      };
      await this.db
        .insertInto('deadline_rules')
        .values({ tenant_id: this.tenantId, priority: rule.priority, ...values })
        .onConflict((conflict) =>
          conflict.columns(['tenant_id', 'priority']).doUpdateSet({
            ...values,
            version: sql<number>`deadline_rules.version + 1`,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    }
    return this.listRules();
  }

  /** The company's working week, as the working-hours clock counts it. */
  async workingHours(): Promise<WorkingHours> {
    const row = await this.db
      .selectFrom('tenant_settings')
      .select(['timezone', 'work_day_starts', 'work_day_ends', 'working_days'])
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return {
      timeZone: row?.timezone ?? 'UTC',
      startsMinute: row?.work_day_starts ?? 480,
      endsMinute: row?.work_day_ends ?? 1020,
      days: row?.working_days ?? [1, 2, 3, 4, 5],
    };
  }

  /**
   * Gives a job its deadlines under the rule for `priority`, counted from its
   * creation. Called when the job is created and when its priority changes. A
   * priority without a rule takes the deadlines away, unless a miss was
   * already recorded: that stays.
   */
  async applyToJob(
    workOrderId: string,
    priority: WorkOrderPriority,
    createdAt: Date,
    context?: { rules?: readonly DeadlineRule[]; hours?: WorkingHours },
  ): Promise<JobDeadline | undefined> {
    const rules = context?.rules ?? (await this.listRules());
    const rule = rules.find((candidate) => candidate.priority === priority);
    const due =
      rule === undefined
        ? undefined
        : deadlinesFor(createdAt, rule, context?.hours ?? (await this.workingHours()));
    if (rule === undefined || due === undefined) {
      await this.db
        .deleteFrom('work_order_deadlines')
        .where('tenant_id', '=', this.tenantId)
        .where('work_order_id', '=', workOrderId)
        .where('response_missed_at', 'is', null)
        .where('completion_missed_at', 'is', null)
        .execute();
      return (await this.ofJobs([workOrderId])).get(workOrderId);
    }
    const values = {
      priority,
      clock: rule.clock,
      warn_minutes: rule.warnMinutes,
      response_due_at: due.responseDueAt,
      completion_due_at: due.completionDueAt,
    };
    await this.db
      .insertInto('work_order_deadlines')
      .values({ tenant_id: this.tenantId, work_order_id: workOrderId, ...values })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'work_order_id']).doUpdateSet(values),
      )
      .execute();
    return (await this.ofJobs([workOrderId])).get(workOrderId);
  }

  async ofJobs(workOrderIds: readonly string[]): Promise<Map<string, JobDeadline>> {
    if (workOrderIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('work_order_deadlines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', 'in', [...new Set(workOrderIds)])
      .execute();
    return new Map(rows.map((row) => [row.work_order_id, toDeadline(row)]));
  }

  /** Deadlines within their warning period, not yet warned about. */
  async dueWarnings(now: Date): Promise<DeadlineNotice[]> {
    const response = await this.db
      .selectFrom('work_order_deadlines')
      .select(['work_order_id', 'response_due_at as due_at', 'priority'])
      .where('tenant_id', '=', this.tenantId)
      .where('response_due_at', 'is not', null)
      .where('responded_at', 'is', null)
      .where('closed_at', 'is', null)
      .where('response_warned_at', 'is', null)
      .where('response_due_at', '>', now)
      .where(sql<boolean>`response_due_at - make_interval(mins => warn_minutes) <= ${now}`)
      .execute();
    const completion = await this.db
      .selectFrom('work_order_deadlines')
      .select(['work_order_id', 'completion_due_at as due_at', 'priority'])
      .where('tenant_id', '=', this.tenantId)
      .where('completion_due_at', 'is not', null)
      .where('completed_at', 'is', null)
      .where('closed_at', 'is', null)
      .where('completion_warned_at', 'is', null)
      .where('completion_due_at', '>', now)
      .where(sql<boolean>`completion_due_at - make_interval(mins => warn_minutes) <= ${now}`)
      .execute();
    return [
      ...response.map((row) => ({
        workOrderId: row.work_order_id,
        kind: 'response' as const,
        dueAt: row.due_at!,
        priority: row.priority,
      })),
      ...completion.map((row) => ({
        workOrderId: row.work_order_id,
        kind: 'completion' as const,
        dueAt: row.due_at!,
        priority: row.priority,
      })),
    ];
  }

  async markWarned(workOrderId: string, kind: DeadlineKind): Promise<void> {
    await this.db
      .updateTable('work_order_deadlines')
      .set(
        kind === 'response'
          ? { response_warned_at: sql<Date>`now()` }
          : { completion_warned_at: sql<Date>`now()` },
      )
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .execute();
  }

  /**
   * Records every deadline that passed unmet and was not yet recorded, and
   * returns them. The miss goes into the job's history by trigger.
   */
  async recordMisses(now: Date): Promise<DeadlineNotice[]> {
    const response = await this.db
      .updateTable('work_order_deadlines')
      .set({ response_missed_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('response_due_at', 'is not', null)
      .where('response_due_at', '<', now)
      .where('responded_at', 'is', null)
      .where('closed_at', 'is', null)
      .where('response_missed_at', 'is', null)
      .returning(['work_order_id', 'response_due_at as due_at', 'priority'])
      .execute();
    const completion = await this.db
      .updateTable('work_order_deadlines')
      .set({ completion_missed_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('completion_due_at', 'is not', null)
      .where('completion_due_at', '<', now)
      .where('completed_at', 'is', null)
      .where('closed_at', 'is', null)
      .where('completion_missed_at', 'is', null)
      .returning(['work_order_id', 'completion_due_at as due_at', 'priority'])
      .execute();
    return [
      ...response.map((row) => ({
        workOrderId: row.work_order_id,
        kind: 'response' as const,
        dueAt: row.due_at!,
        priority: row.priority,
      })),
      ...completion.map((row) => ({
        workOrderId: row.work_order_id,
        kind: 'completion' as const,
        dueAt: row.due_at!,
        priority: row.priority,
      })),
    ];
  }

  /** Jobs with deadlines created between two instants, for the report. */
  async report(query: {
    from: Date;
    to: Date;
    customerId?: string;
    limit?: number;
  }): Promise<DeadlineReportRow[]> {
    let select = this.db
      .selectFrom('work_order_deadlines as d')
      .innerJoin('work_orders as w', (join) =>
        join.onRef('w.tenant_id', '=', 'd.tenant_id').onRef('w.id', '=', 'd.work_order_id'),
      )
      .selectAll('d')
      .select([
        'w.reference',
        'w.title',
        'w.customer_id',
        'w.state',
        'w.created_at as job_created_at',
      ])
      .where('d.tenant_id', '=', this.tenantId)
      .where('w.created_at', '>=', query.from)
      .where('w.created_at', '<', query.to);
    if (query.customerId !== undefined) {
      select = select.where('w.customer_id', '=', query.customerId);
    }
    const rows = await select
      .orderBy('w.created_at', 'desc')
      .limit(query.limit ?? 5000)
      .execute();
    return rows.map((row) => ({
      ...toDeadline(row),
      reference: row.reference,
      title: row.title,
      customerId: row.customer_id,
      state: row.state,
      createdAt: row.job_created_at,
    }));
  }
}

function toDeadline(row: {
  work_order_id: string;
  priority: WorkOrderPriority;
  clock: DeadlineClock;
  warn_minutes: number;
  response_due_at: Date | null;
  completion_due_at: Date | null;
  responded_at: Date | null;
  completed_at: Date | null;
  response_missed_at: Date | null;
  completion_missed_at: Date | null;
  closed_at: Date | null;
}): JobDeadline {
  return {
    workOrderId: row.work_order_id,
    priority: row.priority,
    clock: row.clock,
    warnMinutes: row.warn_minutes,
    responseDueAt: row.response_due_at,
    completionDueAt: row.completion_due_at,
    respondedAt: row.responded_at,
    completedAt: row.completed_at,
    responseMissedAt: row.response_missed_at,
    completionMissedAt: row.completion_missed_at,
    closedAt: row.closed_at,
  };
}
