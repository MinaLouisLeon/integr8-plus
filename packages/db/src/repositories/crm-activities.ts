import {
  type ActivityKind,
  type ActivityStatus,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { CrmActivitiesTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Calls, emails, meetings, notes, follow-ups and tasks (CRM/ERP plan, phase C3).
 *
 * An activity is linked to one or more leads, customers and opportunities
 * through three join tables, each with same-company foreign keys, rather than
 * a free-form "related id" nothing can check. CRM follow-ups are separate from
 * a job's checklist: these are about selling, those about doing the work.
 */

export interface ActivityLinks {
  leadIds: string[];
  customerIds: string[];
  opportunityIds: string[];
}

export interface Activity {
  id: string;
  tenantId: TenantId;
  kind: ActivityKind;
  subject: string;
  detail: string | null;
  outcome: string | null;
  status: ActivityStatus;
  assignedTo: UserId | null;
  dueAt: Date | null;
  completedAt: Date | null;
  completedBy: UserId | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  links: ActivityLinks;
}

export interface ActivityInput {
  kind: ActivityKind;
  subject: string;
  detail?: string | null;
  outcome?: string | null;
  assignedTo?: UserId | string | null;
  dueAt?: Date | null;
}

/** When an activity is due, read in the company's time zone. */
export type ActivityDue = 'overdue' | 'today' | 'upcoming' | 'none';

export interface ActivityQuery {
  statuses?: readonly ActivityStatus[];
  /** One member's; `null` for nobody's. */
  assignedTo?: UserId | string | null;
  due?: ActivityDue;
  /** The company's IANA time zone, for what "today" means. */
  timeZone: string;
  leadId?: string;
  customerId?: string;
  opportunityId?: string;
  /**
   * `due`: soonest first, those with no date last — the to-do list.
   * `recent`: newest first — a record's timeline.
   */
  order?: 'due' | 'recent';
  after?: { at: Date | null; id: string };
  limit?: number;
}

export interface ActivityPage {
  items: Activity[];
  next: { at: Date | null; id: string } | undefined;
}

export type ActivityRefusal = 'not_found' | 'version_conflict';

/** Start of today and of tomorrow in a time zone, as SQL expressions. */
function dayBounds(timeZone: string) {
  const today = sql<Date>`(date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone})`;
  const tomorrow = sql<Date>`((date_trunc('day', now() at time zone ${timeZone}) + interval '1 day') at time zone ${timeZone})`;
  return { today, tomorrow };
}

export class CrmActivitiesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #activities() {
    return this.db
      .selectFrom('crm_activities')
      .where('crm_activities.tenant_id', '=', this.tenantId);
  }

  /**
   * A new activity and its links. `done` records something that already
   * happened (a call made, a note written) by `createdBy`, now.
   */
  async create(
    input: ActivityInput & { done: boolean },
    links: ActivityLinks,
    createdBy: UserId | string,
  ): Promise<Activity> {
    const row = await this.db
      .insertInto('crm_activities')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...columns(input),
        kind: input.kind,
        subject: input.subject.trim(),
        ...(input.done
          ? { status: 'done', completed_at: sql<Date>`now()`, completed_by: toUserId(createdBy) }
          : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const link = { tenant_id: this.tenantId, activity_id: row.id };
    if (links.leadIds.length > 0) {
      await this.db
        .insertInto('crm_activity_leads')
        .values([...new Set(links.leadIds)].map((lead_id) => ({ ...link, lead_id })))
        .execute();
    }
    if (links.customerIds.length > 0) {
      await this.db
        .insertInto('crm_activity_customers')
        .values([...new Set(links.customerIds)].map((customer_id) => ({ ...link, customer_id })))
        .execute();
    }
    if (links.opportunityIds.length > 0) {
      await this.db
        .insertInto('crm_activity_opportunities')
        .values(
          [...new Set(links.opportunityIds)].map((opportunity_id) => ({ ...link, opportunity_id })),
        )
        .execute();
    }
    return (await this.#withLinks([row]))[0]!;
  }

  async find(activityId: string): Promise<Activity | undefined> {
    const row = await this.#activities()
      .selectAll()
      .where('id', '=', activityId)
      .executeTakeFirst();
    return row === undefined ? undefined : (await this.#withLinks([row]))[0];
  }

  /**
   * Changes an activity, provided nobody has changed it since
   * `expectedVersion`. Marking it done records who and when; reopening or
   * cancelling clears that.
   */
  async update(
    activityId: string,
    expectedVersion: number,
    input: Partial<Omit<ActivityInput, 'kind'>> & { status?: ActivityStatus },
    actorId: UserId | string,
  ): Promise<Activity | ActivityRefusal> {
    const status =
      input.status === undefined
        ? {}
        : input.status === 'done'
          ? {
              status: 'done' as const,
              completed_at: sql<Date>`case when status = 'done' then completed_at else now() end`,
              completed_by: sql<string>`case when status = 'done' then completed_by else ${toUserId(actorId)}::uuid end`,
            }
          : { status: input.status, completed_at: null, completed_by: null };
    const row = await this.db
      .updateTable('crm_activities')
      .set({ ...columns(input), ...status, version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', activityId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return (await this.#withLinks([row]))[0]!;
    }
    return (await this.find(activityId)) === undefined ? 'not_found' : 'version_conflict';
  }

  async list(query: ActivityQuery): Promise<ActivityPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const order = query.order ?? 'due';
    let select = this.#activities().selectAll();

    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.assignedTo === null) {
      select = select.where('assigned_to', 'is', null);
    } else if (query.assignedTo !== undefined) {
      select = select.where('assigned_to', '=', toUserId(query.assignedTo));
    }
    if (query.due !== undefined) {
      const { today, tomorrow } = dayBounds(query.timeZone);
      select = select.where(
        query.due === 'none'
          ? sql<boolean>`due_at is null`
          : query.due === 'overdue'
            ? sql<boolean>`due_at < ${today}`
            : query.due === 'today'
              ? sql<boolean>`due_at >= ${today} and due_at < ${tomorrow}`
              : sql<boolean>`due_at >= ${tomorrow}`,
      );
    }
    if (query.leadId !== undefined) {
      select = select.where(
        sql<boolean>`exists (select 1 from crm_activity_leads l where l.tenant_id = crm_activities.tenant_id and l.activity_id = crm_activities.id and l.lead_id = ${query.leadId})`,
      );
    }
    if (query.customerId !== undefined) {
      select = select.where(
        sql<boolean>`exists (select 1 from crm_activity_customers c where c.tenant_id = crm_activities.tenant_id and c.activity_id = crm_activities.id and c.customer_id = ${query.customerId})`,
      );
    }
    if (query.opportunityId !== undefined) {
      select = select.where(
        sql<boolean>`exists (select 1 from crm_activity_opportunities o where o.tenant_id = crm_activities.tenant_id and o.activity_id = crm_activities.id and o.opportunity_id = ${query.opportunityId})`,
      );
    }

    // Millisecond precision throughout: a cursor carries a JavaScript date.
    const due = sql`date_trunc('milliseconds', due_at)`;
    const created = sql`date_trunc('milliseconds', created_at)`;
    const after = query.after;
    if (after !== undefined) {
      if (order === 'recent') {
        select = select.where(
          sql<boolean>`(${created}, id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        );
      } else if (after.at === null) {
        // Past every dated one: only undated ones remain, by id.
        select = select.where(sql<boolean>`due_at is null and id > ${after.id}::uuid`);
      } else {
        select = select.where(
          sql<boolean>`(due_at is null or (${due}, id) > (${after.at}::timestamptz, ${after.id}::uuid))`,
        );
      }
    }

    const rows = await (
      order === 'recent'
        ? select.orderBy(created, 'desc').orderBy('id', 'desc')
        : select
            .orderBy(sql`due_at is null`)
            .orderBy(due)
            .orderBy('id')
    )
      .limit(limit + 1)
      .execute();
    const items = await this.#withLinks(rows.slice(0, limit));
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { at: order === 'recent' ? last.createdAt : last.dueAt, id: last.id }
          : undefined,
    };
  }

  /** Open ones by when they are due: overdue, due today, and the given member's open ones. */
  async counts(
    timeZone: string,
    userId: UserId | string,
  ): Promise<{ overdue: number; dueToday: number; mineOpen: number }> {
    const { today, tomorrow } = dayBounds(timeZone);
    const row = await this.#activities()
      .select([
        sql<string>`count(*) filter (where due_at < ${today})`.as('overdue'),
        sql<string>`count(*) filter (where due_at >= ${today} and due_at < ${tomorrow})`.as(
          'due_today',
        ),
        sql<string>`count(*) filter (where assigned_to = ${toUserId(userId)}::uuid)`.as(
          'mine_open',
        ),
      ])
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    return {
      overdue: Number(row.overdue),
      dueToday: Number(row.due_today),
      mineOpen: Number(row.mine_open),
    };
  }

  async #withLinks(rows: readonly Selectable<CrmActivitiesTable>[]): Promise<Activity[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const [leads, customers, opportunities] = await Promise.all([
      this.db
        .selectFrom('crm_activity_leads')
        .select(['activity_id', 'lead_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('activity_id', 'in', ids)
        .execute(),
      this.db
        .selectFrom('crm_activity_customers')
        .select(['activity_id', 'customer_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('activity_id', 'in', ids)
        .execute(),
      this.db
        .selectFrom('crm_activity_opportunities')
        .select(['activity_id', 'opportunity_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('activity_id', 'in', ids)
        .execute(),
    ]);
    return rows.map((row) =>
      toActivity(row, {
        leadIds: leads.filter((link) => link.activity_id === row.id).map((link) => link.lead_id),
        customerIds: customers
          .filter((link) => link.activity_id === row.id)
          .map((link) => link.customer_id),
        opportunityIds: opportunities
          .filter((link) => link.activity_id === row.id)
          .map((link) => link.opportunity_id),
      }),
    );
  }
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function columns(input: Partial<ActivityInput>) {
  return {
    ...(input.subject === undefined ? {} : { subject: input.subject.trim() }),
    ...(input.detail === undefined ? {} : { detail: blankToNull(input.detail) }),
    ...(input.outcome === undefined ? {} : { outcome: blankToNull(input.outcome) }),
    ...(input.assignedTo === undefined
      ? {}
      : { assigned_to: input.assignedTo === null ? null : toUserId(input.assignedTo) }),
    ...(input.dueAt === undefined ? {} : { due_at: input.dueAt }),
  };
}

function toActivity(row: Selectable<CrmActivitiesTable>, links: ActivityLinks): Activity {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    kind: row.kind,
    subject: row.subject,
    detail: row.detail,
    outcome: row.outcome,
    status: row.status,
    assignedTo: row.assigned_to === null ? null : toUserId(row.assigned_to),
    dueAt: row.due_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by === null ? null : toUserId(row.completed_by),
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    links,
  };
}
