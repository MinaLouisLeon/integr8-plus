import {
  CLOSED_WORK_ORDER_STATES,
  type DoubleBooking,
  slotProblem,
  type SlotProblem,
  toUserId,
  type UserId,
  type VisitStatus,
  type WorkOrderState,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { WorkOrderVisitsTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/** One trip to do a job, with the people on it now (P25, migration 0051). */
export interface Visit {
  id: string;
  workOrderId: string;
  startsAt: Date;
  endsAt: Date;
  status: VisitStatus;
  notes: string | null;
  completedAt: Date | null;
  completedBy: UserId | null;
  cancelledAt: Date | null;
  cancelledBy: UserId | null;
  cancelReason: string | null;
  revision: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  assigneeIds: UserId[];
}

export interface CreateVisitInput {
  workOrderId: string;
  startsAt: Date;
  endsAt: Date;
  notes?: string | null;
  assigneeIds?: readonly string[];
}

export interface VisitChanges {
  startsAt?: Date;
  endsAt?: Date;
  notes?: string | null;
  /** The people on the visit, exactly. */
  assigneeIds?: readonly string[];
}

export interface VisitRangeQuery {
  /** Visits that end after this… */
  from: Date;
  /** …and start before this. */
  to: Date;
  /** Only visits with at least one of these people on them. */
  userIds?: readonly string[];
  /** Done and planned by default; cancelled only when asked. */
  includeCancelled?: boolean;
}

/** Why a visit could not be written. */
export type VisitRefusal =
  | { outcome: 'not_found' }
  | { outcome: 'job_not_found' }
  | { outcome: 'job_closed'; state: WorkOrderState }
  | { outcome: 'conflict'; current: Visit }
  | { outcome: 'final'; current: Visit }
  | { outcome: 'invalid_slot'; problem: SlotProblem }
  | { outcome: 'not_on_crew'; userIds: UserId[] }
  | { outcome: 'double_booked'; conflicts: DoubleBooking[] };

export type VisitWrite = { outcome: 'written'; visit: Visit } | VisitRefusal;

export interface UnscheduledJob {
  workOrderId: string;
  /** Minutes the job type expects, if it says. */
  expectedDurationMinutes: number | null;
}

/** Trimmed text, or null when there is none. */
function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

const EXCLUSION_VIOLATION = '23P01';

/**
 * Visits for one company.
 *
 * Migration 0051 enforces every rule here for every client: no double booking
 * across jobs, only the job's crew on its visits, no planned visit on a closed
 * job, done and cancelled final. This class checks first so a refusal can say
 * exactly what is wrong, and reports the database's refusal the same way when
 * a concurrent change got there first.
 */
export class WorkOrderVisitsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #visits() {
    return this.db
      .selectFrom('work_order_visits')
      .where('work_order_visits.tenant_id', '=', this.tenantId);
  }

  async find(visitId: string): Promise<Visit | undefined> {
    const row = await this.#visits().selectAll().where('id', '=', visitId).executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const people = await this.#assignees([row.id]);
    return toVisit(row, people.get(row.id) ?? []);
  }

  /** Visits overlapping a window, earliest first: what a calendar shows. */
  async listInRange(query: VisitRangeQuery): Promise<Visit[]> {
    let select = this.#visits()
      .selectAll('work_order_visits')
      .where('work_order_visits.ends_at', '>', query.from)
      .where('work_order_visits.starts_at', '<', query.to);
    if (query.includeCancelled !== true) {
      select = select.where('work_order_visits.status', '<>', 'cancelled');
    }
    if (query.userIds !== undefined) {
      if (query.userIds.length === 0) {
        return [];
      }
      const userIds = [...new Set(query.userIds)];
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom('work_order_visit_assignees as a')
            .select('a.id')
            .where('a.tenant_id', '=', this.tenantId)
            .whereRef('a.visit_id', '=', 'work_order_visits.id')
            .where('a.removed_at', 'is', null)
            .where('a.user_id', 'in', userIds),
        ),
      );
    }
    const rows = await select
      .orderBy('work_order_visits.starts_at')
      .orderBy('work_order_visits.id')
      .limit(5000)
      .execute();
    const people = await this.#assignees(rows.map((row) => row.id));
    return rows.map((row) => toVisit(row, people.get(row.id) ?? []));
  }

  /** Every visit of these jobs, earliest first, grouped by job. */
  async listForWorkOrders(workOrderIds: readonly string[]): Promise<Map<string, Visit[]>> {
    const byJob = new Map<string, Visit[]>();
    if (workOrderIds.length === 0) {
      return byJob;
    }
    const rows = await this.#visits()
      .selectAll()
      .where('work_order_id', 'in', [...new Set(workOrderIds)])
      .orderBy('starts_at')
      .orderBy('id')
      .execute();
    const people = await this.#assignees(rows.map((row) => row.id));
    for (const row of rows) {
      byJob.set(row.work_order_id, [
        ...(byJob.get(row.work_order_id) ?? []),
        toVisit(row, people.get(row.id) ?? []),
      ]);
    }
    return byJob;
  }

  /**
   * Open jobs with no planned visit, newest priority first then oldest: the
   * board's "unscheduled" list.
   */
  async listUnscheduled(limit = 200): Promise<UnscheduledJob[]> {
    const rows = await this.db
      .selectFrom('work_orders as w')
      .innerJoin('job_types as t', (join) =>
        join.onRef('t.id', '=', 'w.job_type_id').onRef('t.tenant_id', '=', 'w.tenant_id'),
      )
      .select(['w.id', 't.expected_duration_minutes'])
      .where('w.tenant_id', '=', this.tenantId)
      .where('w.state', 'not in', [...CLOSED_WORK_ORDER_STATES])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('work_order_visits as v')
              .select('v.id')
              .where('v.tenant_id', '=', this.tenantId)
              .whereRef('v.work_order_id', '=', 'w.id')
              .where('v.status', '=', 'planned'),
          ),
        ),
      )
      .orderBy(
        sql`case w.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
      )
      .orderBy('w.created_at')
      .limit(Math.min(Math.max(limit, 1), 500))
      .execute();
    return rows.map((row) => ({
      workOrderId: row.id,
      expectedDurationMinutes: row.expected_duration_minutes,
    }));
  }

  async create(input: CreateVisitInput, actor: UserId | string): Promise<VisitWrite> {
    const problem = slotProblem(input);
    if (problem !== undefined) {
      return { outcome: 'invalid_slot', problem };
    }
    const job = await this.#job(input.workOrderId);
    if (job === undefined) {
      return { outcome: 'job_not_found' };
    }
    if (CLOSED_WORK_ORDER_STATES.includes(job.state)) {
      return { outcome: 'job_closed', state: job.state };
    }
    const people = [...new Set(input.assigneeIds ?? [])];
    const outsiders = await this.#notOnCrew(input.workOrderId, people);
    if (outsiders.length > 0) {
      return { outcome: 'not_on_crew', userIds: outsiders };
    }
    const by = toUserId(actor);
    return this.#guarded(
      async () => {
        const row = await this.db
          .insertInto('work_order_visits')
          .values({
            tenant_id: this.tenantId,
            work_order_id: input.workOrderId,
            starts_at: input.startsAt,
            ends_at: input.endsAt,
            notes: textOrNull(input.notes),
            last_actor: by,
            created_by: by,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.#add(row.id, people, by);
        return row.id;
      },
      { ...input, id: '', assigneeIds: people },
    );
  }

  /**
   * Moves a visit, changes its notes or who is on it. Refused when someone else
   * changed it since `expectedRevision`, or when it is done or cancelled.
   */
  async update(
    visitId: string,
    expectedRevision: number,
    changes: VisitChanges,
    actor: UserId | string,
  ): Promise<VisitWrite> {
    const current = await this.find(visitId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.revision !== expectedRevision) {
      return { outcome: 'conflict', current };
    }
    if (current.status !== 'planned') {
      return { outcome: 'final', current };
    }
    const slot = {
      startsAt: changes.startsAt ?? current.startsAt,
      endsAt: changes.endsAt ?? current.endsAt,
    };
    const problem = slotProblem(slot);
    if (problem !== undefined) {
      return { outcome: 'invalid_slot', problem };
    }
    const people =
      changes.assigneeIds === undefined ? current.assigneeIds : [...new Set(changes.assigneeIds)];
    const arriving = people.filter((userId) => !current.assigneeIds.includes(toUserId(userId)));
    const outsiders = await this.#notOnCrew(current.workOrderId, arriving);
    if (outsiders.length > 0) {
      return { outcome: 'not_on_crew', userIds: outsiders };
    }
    const by = toUserId(actor);
    return this.#guarded(
      async () => {
        const leaving = current.assigneeIds.filter((userId) => !people.includes(userId));
        // Take people off before moving, so a move that frees someone is not
        // refused for the person leaving; add the newcomers after, at the new time.
        if (leaving.length > 0) {
          await this.db
            .updateTable('work_order_visit_assignees')
            .set({ removed_at: sql<Date>`now()`, removed_by: by })
            .where('tenant_id', '=', this.tenantId)
            .where('visit_id', '=', visitId)
            .where('user_id', 'in', leaving)
            .where('removed_at', 'is', null)
            .execute();
        }
        const row = await this.db
          .updateTable('work_order_visits')
          .set({
            starts_at: slot.startsAt,
            ends_at: slot.endsAt,
            ...(changes.notes === undefined ? {} : { notes: textOrNull(changes.notes) }),
            last_actor: by,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', visitId)
          .where('revision', '=', expectedRevision)
          .where('status', '=', 'planned')
          .returning('id')
          .executeTakeFirst();
        if (row === undefined) {
          return undefined;
        }
        await this.#add(visitId, arriving, by);
        return visitId;
      },
      { ...current, ...slot, assigneeIds: people },
    );
  }

  /** Calls a planned visit off. Final. */
  async cancel(
    visitId: string,
    expectedRevision: number,
    reason: string | null,
    actor: UserId | string,
  ): Promise<VisitWrite> {
    const current = await this.find(visitId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.revision !== expectedRevision) {
      return { outcome: 'conflict', current };
    }
    if (current.status !== 'planned') {
      return { outcome: 'final', current };
    }
    const by = toUserId(actor);
    const row = await this.db
      .updateTable('work_order_visits')
      .set({
        status: 'cancelled',
        cancelled_at: sql<Date>`now()`,
        cancelled_by: by,
        cancel_reason: textOrNull(reason),
        last_actor: by,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', visitId)
      .where('revision', '=', expectedRevision)
      .where('status', '=', 'planned')
      .returning('id')
      .executeTakeFirst();
    return this.#readBack(visitId, row !== undefined);
  }

  /**
   * Marks a visit done, at the time the phone recorded it. Doing it twice is
   * not an error: a phone resending after a lost reply finds it already done.
   */
  async markDone(visitId: string, completedAt: Date, actor: UserId | string): Promise<VisitWrite> {
    const current = await this.find(visitId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.status === 'done') {
      return { outcome: 'written', visit: current };
    }
    if (current.status === 'cancelled') {
      return { outcome: 'final', current };
    }
    const by = toUserId(actor);
    const row = await this.db
      .updateTable('work_order_visits')
      .set({
        status: 'done',
        // Never in the future, whatever a phone's clock says.
        completed_at: sql<Date>`least(${completedAt}::timestamptz, now())`,
        completed_by: by,
        last_actor: by,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', visitId)
      .where('status', '=', 'planned')
      .returning('id')
      .executeTakeFirst();
    return this.#readBack(visitId, row !== undefined);
  }

  /** Whether this person is on the visit now. */
  async isAssigned(visitId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('work_order_visit_assignees')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('visit_id', '=', visitId)
      .where('user_id', '=', userId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Planned visits of other jobs that overlap a slot for any of these people:
   * what makes a placement a double booking.
   */
  async findDoubleBookings(candidate: {
    id: string;
    workOrderId: string;
    startsAt: Date;
    endsAt: Date;
    assigneeIds: readonly string[];
  }): Promise<DoubleBooking[]> {
    if (candidate.assigneeIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('work_order_visit_assignees')
      .select(['user_id', 'visit_id', 'work_order_id'])
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', 'in', [...new Set(candidate.assigneeIds)])
      .where('work_order_id', '<>', candidate.workOrderId)
      .where('planned', '=', true)
      .where('removed_at', 'is', null)
      .where('starts_at', '<', candidate.endsAt)
      .where('ends_at', '>', candidate.startsAt)
      .orderBy('starts_at')
      .execute();
    return rows.map((row) => ({
      userId: row.user_id,
      visitId: candidate.id,
      conflictingVisitId: row.visit_id,
      conflictingWorkOrderId: row.work_order_id,
    }));
  }

  // -------------------------------------------------------------------------

  async #job(workOrderId: string) {
    return this.db
      .selectFrom('work_orders')
      .select(['id', 'state'])
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', workOrderId)
      .executeTakeFirst();
  }

  async #notOnCrew(workOrderId: string, userIds: readonly string[]): Promise<UserId[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('work_order_assignments')
      .select('user_id')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('user_id', 'in', [...userIds])
      .where('unassigned_at', 'is', null)
      .execute();
    const crew = new Set(rows.map((row) => row.user_id));
    return userIds.filter((userId) => !crew.has(userId)).map(toUserId);
  }

  async #add(visitId: string, userIds: readonly string[], by: UserId) {
    if (userIds.length === 0) {
      return;
    }
    await this.db
      .insertInto('work_order_visit_assignees')
      .values(
        userIds.map((userId) => ({
          tenant_id: this.tenantId,
          visit_id: visitId,
          user_id: userId,
          assigned_by: by,
        })),
      )
      .execute();
  }

  async #assignees(visitIds: readonly string[]): Promise<Map<string, UserId[]>> {
    const people = new Map<string, UserId[]>();
    if (visitIds.length === 0) {
      return people;
    }
    const rows = await this.db
      .selectFrom('work_order_visit_assignees')
      .select(['visit_id', 'user_id'])
      .where('tenant_id', '=', this.tenantId)
      .where('visit_id', 'in', [...new Set(visitIds)])
      .where('removed_at', 'is', null)
      .orderBy('assigned_at')
      .execute();
    for (const row of rows) {
      people.set(row.visit_id, [...(people.get(row.visit_id) ?? []), toUserId(row.user_id)]);
    }
    return people;
  }

  /**
   * Runs a write in a savepoint, turning the database's own refusals into the
   * same outcomes the checks above give: a double booking (the exclusion
   * constraint), a job closed or a visit finished in between, someone taken off
   * the crew in between.
   */
  async #guarded(
    write: () => Promise<string | undefined>,
    candidate: {
      id: string;
      workOrderId: string;
      startsAt: Date;
      endsAt: Date;
      assigneeIds: readonly string[];
    },
  ): Promise<VisitWrite> {
    await sql`savepoint work_order_visit_write`.execute(this.db);
    let visitId: string | undefined;
    try {
      visitId = await write();
      // Nothing written means someone else got there first: undo any part done.
      await (
        visitId === undefined
          ? sql`rollback to savepoint work_order_visit_write`
          : sql`release savepoint work_order_visit_write`
      ).execute(this.db);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== EXCLUSION_VIOLATION && code !== '23514' && code !== '55000') {
        throw error;
      }
      await sql`rollback to savepoint work_order_visit_write`.execute(this.db);
      if (code === EXCLUSION_VIOLATION) {
        return { outcome: 'double_booked', conflicts: await this.findDoubleBookings(candidate) };
      }
      const job = await this.#job(candidate.workOrderId);
      if (job === undefined) {
        return { outcome: 'job_not_found' };
      }
      if (CLOSED_WORK_ORDER_STATES.includes(job.state)) {
        return { outcome: 'job_closed', state: job.state };
      }
      if (candidate.id !== '') {
        const current = await this.find(candidate.id);
        if (current === undefined) {
          return { outcome: 'not_found' };
        }
        if (current.status !== 'planned') {
          return { outcome: 'final', current };
        }
      }
      return {
        outcome: 'not_on_crew',
        userIds: await this.#notOnCrew(candidate.workOrderId, candidate.assigneeIds),
      };
    }
    if (visitId === undefined) {
      const current = await this.find(candidate.id);
      return current === undefined ? { outcome: 'not_found' } : { outcome: 'conflict', current };
    }
    const visit = await this.find(visitId);
    return visit === undefined ? { outcome: 'not_found' } : { outcome: 'written', visit };
  }

  async #readBack(visitId: string, written: boolean): Promise<VisitWrite> {
    const current = await this.find(visitId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (written) {
      return { outcome: 'written', visit: current };
    }
    return current.status === 'planned'
      ? { outcome: 'conflict', current }
      : { outcome: 'final', current };
  }
}

function toVisit(row: Selectable<WorkOrderVisitsTable>, assigneeIds: UserId[]): Visit {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    notes: row.notes,
    completedAt: row.completed_at,
    completedBy: row.completed_by === null ? null : toUserId(row.completed_by),
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelReason: row.cancel_reason,
    revision: row.revision,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assigneeIds,
  };
}
