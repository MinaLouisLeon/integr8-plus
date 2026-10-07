import { type PlatformUserId, type TenantId, toTenantId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import {
  type BillingMode,
  type Database,
  type TenantPlan,
  type TenantStatus,
  tenantStatusSchema,
  type TenantsTable,
} from '../schema.js';

export interface Tenant {
  id: TenantId;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: TenantPlan;
  seats: number | null;
  /**
   * How the company pays (P17, revised): `self_serve` through the billing
   * provider in the app, `invoiced` by Integr8 directly with the plan set from
   * the dashboard.
   */
  billingMode: BillingMode;
  suspendedAt: Date | null;
  /** Why the company was stopped, in words its own people are shown. */
  suspendedReason: string | null;
  /**
   * Non-payment or a lapsed trial (P17), and not the same as suspended: reads
   * keep working so a company can get its data out and fix its card.
   */
  readOnlySince: Date | null;
  readOnlyReason: string | null;
  onboardedBy: PlatformUserId | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** A company in the directory, with what the platform wants to see beside it. */
export interface TenantSummary extends Tenant {
  members: number;
  activeMembers: number;
  storageBytes: number;
  /** The most recent sign-in, job change or submission: whether anybody is using it. */
  lastActivityAt: Date | null;
}

/** One month of a company's activity, for the dashboard's per-company view. */
export interface TenantActivityMonth {
  /** `YYYY-MM`. */
  month: string;
  jobs: number;
  submissions: number;
  activeUsers: number;
  /** Everything recorded in this company's audit log; see `monthlyActivity`. */
  auditedActions: number;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  status?: TenantStatus;
  plan?: TenantPlan;
  seats?: number | null;
  billingMode?: BillingMode;
  onboardedBy?: PlatformUserId | string | null;
}

/**
 * Companies themselves.
 *
 * Deliberately *not* tenant-scoped: creating a company is by definition an act
 * outside every company, so this repository runs on the platform data source,
 * as the schema owner, where RLS does not apply. That is a privilege, and P03
 * puts platform authentication and a mandatory audit entry in front of every
 * caller. Nothing serving a tenant request may construct one.
 *
 * A tenant request that needs to read its *own* company row does so through the
 * tenant data source, where the `tenants_own_row` policy limits it to one row.
 */
export class TenantsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateTenantInput): Promise<Tenant> {
    const row = await this.db
      .insertInto('tenants')
      .values({
        slug: input.slug.trim().toLowerCase(),
        name: input.name.trim(),
        ...(input.status === undefined ? {} : { status: tenantStatusSchema.parse(input.status) }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.seats === undefined ? {} : { seats: input.seats }),
        ...(input.billingMode === undefined ? {} : { billing_mode: input.billingMode }),
        ...(input.onboardedBy === undefined ? {} : { onboarded_by: input.onboardedBy }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findById(tenantId: TenantId | string): Promise<Tenant | undefined> {
    const row = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', toTenantId(tenantId))
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async findBySlug(slug: string): Promise<Tenant | undefined> {
    const row = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('slug', '=', slug.trim().toLowerCase())
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async list(options: { includeDeleted?: boolean } = {}): Promise<Tenant[]> {
    let query = this.db.selectFrom('tenants').selectAll().orderBy('created_at', 'asc');
    if (options.includeDeleted !== true) {
      query = query.where('deleted_at', 'is', null);
    }
    return (await query.execute()).map(toDomain);
  }

  async setStatus(tenantId: TenantId | string, status: TenantStatus): Promise<Tenant | undefined> {
    const row = await this.db
      .updateTable('tenants')
      .set({ status: tenantStatusSchema.parse(status) })
      .where('id', '=', toTenantId(tenantId))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Stops a company, with the reason its people will read. Suspended and why
   * are one fact in the schema, so they cannot come apart here either.
   */
  async suspend(
    tenantId: TenantId | string,
    reason: string,
    now = new Date(),
  ): Promise<Tenant | undefined> {
    const row = await this.db
      .updateTable('tenants')
      .set({ status: 'suspended', suspended_at: now, suspended_reason: reason.trim() })
      .where('id', '=', toTenantId(tenantId))
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Marks a company read-only, or lifts it (P17).
   *
   * Beside `suspend` because it is the same kind of fact about the same row,
   * and deliberately not the same thing: a suspended company is refused
   * everything, a read-only one keeps its reads so it can export its data and
   * fix its card.
   *
   * Marking one that is already read-only does nothing, so a dunning job that
   * runs twice does not move the date somebody reads to work out how long this
   * has been going on.
   */
  async setReadOnly(
    tenantId: TenantId | string,
    reason: string | null,
    now = new Date(),
  ): Promise<Tenant | undefined> {
    const row = await this.db
      .updateTable('tenants')
      .set(
        reason === null
          ? { read_only_since: null, read_only_reason: null }
          : { read_only_since: now, read_only_reason: reason },
      )
      .where('id', '=', toTenantId(tenantId))
      .where('read_only_since', reason === null ? 'is not' : 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async reactivate(tenantId: TenantId | string): Promise<Tenant | undefined> {
    const row = await this.db
      .updateTable('tenants')
      .set({ status: 'active', suspended_at: null, suspended_reason: null })
      .where('id', '=', toTenantId(tenantId))
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async setPlan(
    tenantId: TenantId | string,
    input: { plan?: TenantPlan; seats?: number | null; billingMode?: BillingMode },
  ): Promise<Tenant | undefined> {
    const row = await this.db
      .updateTable('tenants')
      .set({
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.seats === undefined ? {} : { seats: input.seats }),
        ...(input.billingMode === undefined ? {} : { billing_mode: input.billingMode }),
      })
      .where('id', '=', toTenantId(tenantId))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * The directory: every company with its people, its storage and when anything
   * last happened in it. One query, because the screen shows them together and
   * a per-company round trip would be a hundred round trips at a hundred
   * customers.
   */
  async directory(options: { includeDeleted?: boolean } = {}): Promise<TenantSummary[]> {
    let query = this.db
      .selectFrom('tenants')
      .selectAll('tenants')
      .select((eb) => [
        eb
          .selectFrom('tenant_users')
          .select((count) => count.fn.countAll<string>().as('value'))
          .whereRef('tenant_users.tenant_id', '=', 'tenants.id')
          .where('tenant_users.deleted_at', 'is', null)
          .as('members'),
        eb
          .selectFrom('tenant_users')
          .select((count) => count.fn.countAll<string>().as('value'))
          .whereRef('tenant_users.tenant_id', '=', 'tenants.id')
          .where('tenant_users.deleted_at', 'is', null)
          .where('tenant_users.status', '=', 'active')
          .as('active_members'),
        eb
          .selectFrom('tenant_storage_usage')
          .select(sql<string>`coalesce(sum(bytes), 0)`.as('value'))
          .whereRef('tenant_storage_usage.tenant_id', '=', 'tenants.id')
          .as('storage_bytes'),
        eb
          .selectFrom('sessions')
          .select((max) => max.fn.max<Date | null>('sessions.last_seen_at').as('value'))
          .whereRef('sessions.tenant_id', '=', 'tenants.id')
          .as('last_seen_at'),
        eb
          .selectFrom('audit_log')
          .select((max) => max.fn.max<Date | null>('audit_log.occurred_at').as('value'))
          .whereRef('audit_log.tenant_id', '=', 'tenants.id')
          .as('last_audit_at'),
      ])
      .orderBy('tenants.created_at', 'asc');

    if (options.includeDeleted !== true) {
      query = query.where('tenants.deleted_at', 'is', null);
    }

    return (await query.execute()).map((row) => {
      const seen = [row.last_seen_at, row.last_audit_at].filter(
        (value): value is Date => value instanceof Date,
      );
      return {
        ...toDomain(row),
        members: Number(row.members ?? 0),
        activeMembers: Number(row.active_members ?? 0),
        storageBytes: Number(row.storage_bytes ?? 0),
        lastActivityAt:
          seen.length === 0
            ? null
            : seen.reduce((latest, value) => (value > latest ? value : latest)),
      };
    });
  }

  /**
   * Removes a company that never got off the ground (P15).
   *
   * Only for the seconds between creating the row and finishing onboarding: if
   * anything at all has attached itself since, every one of those foreign keys
   * is `on delete restrict` and Postgres refuses — which is the right answer,
   * because a company with data in it goes through export and cooling-off like
   * any other. Returns false in that case rather than throwing, so a cleanup
   * path cannot turn one failure into two.
   */
  async deleteEmpty(tenantId: TenantId | string): Promise<boolean> {
    try {
      const result = await this.db
        .deleteFrom('tenants')
        .where('id', '=', toTenantId(tenantId))
        .executeTakeFirst();

      return (result.numDeletedRows ?? 0n) > 0n;
    } catch {
      return false;
    }
  }

  /**
   * How busy one company has been, month by month (P15).
   *
   * Counted here rather than through the tenant connection because this is the
   * platform asking, and going through RLS would mean opening a tenant
   * connection for a read that is nobody's business but ours.
   *
   * `auditedActions` rather than "API calls": there is no request-level counter
   * in this system, and there is no honest way to derive one. What the audit
   * log holds is every action anybody took that was worth recording, which is
   * the question people actually mean when they ask how busy a customer is.
   */
  async monthlyActivity(tenantId: TenantId | string, months = 12): Promise<TenantActivityMonth[]> {
    const id = toTenantId(tenantId);
    const since = sql<Date>`date_trunc('month', now()) - make_interval(months => ${months - 1})`;

    const rows = await sql<{
      month: Date;
      jobs: string;
      submissions: string;
      active_users: string;
      audited_actions: string;
    }>`
      with months as (
        select generate_series(${since}, date_trunc('month', now()), interval '1 month') as month
      )
      select
        months.month,
        (select count(*) from work_orders w
          where w.tenant_id = ${id}
            and date_trunc('month', w.created_at) = months.month) as jobs,
        (select count(*) from submissions s
          where s.tenant_id = ${id}
            and date_trunc('month', s.created_at) = months.month) as submissions,
        (select count(distinct a.actor_id) from audit_log a
          where a.tenant_id = ${id}
            and a.actor_kind = 'tenant_user'
            and date_trunc('month', a.occurred_at) = months.month) as active_users,
        (select count(*) from audit_log a
          where a.tenant_id = ${id}
            and date_trunc('month', a.occurred_at) = months.month) as audited_actions
      from months
      order by months.month asc
    `.execute(this.db);

    return rows.rows.map((row) => ({
      // `2026-09`, which is what a chart axis wants and what a human reads.
      month: row.month.toISOString().slice(0, 7),
      jobs: Number(row.jobs),
      submissions: Number(row.submissions),
      activeUsers: Number(row.active_users),
      auditedActions: Number(row.audited_actions),
    }));
  }

  /**
   * Soft-deletes a company. Hard deletion is not offered: `audit_log.tenant_id`
   * is `on delete restrict`, so the history would block it anyway, and that is
   * the correct answer rather than an obstacle to route around.
   */
  async softDelete(tenantId: TenantId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('tenants')
      .set({ deleted_at: new Date(), status: 'cancelled' })
      .where('id', '=', toTenantId(tenantId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

function toDomain(row: Selectable<TenantsTable>): Tenant {
  return {
    id: toTenantId(row.id),
    slug: row.slug,
    name: row.name,
    status: tenantStatusSchema.parse(row.status),
    plan: row.plan,
    seats: row.seats,
    billingMode: row.billing_mode,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    readOnlySince: row.read_only_since,
    readOnlyReason: row.read_only_reason,
    onboardedBy: row.onboarded_by as PlatformUserId | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
