import type { Kysely, Selectable } from 'kysely';
import type { Database, SubscriptionsTable, SubscriptionStatus, TenantPlan } from '../schema.js';

/**
 * What each company is on (P17; P42).
 *
 * Integr8 invoices every company directly, so this holds the plan the API
 * enforces and where the company stands, written by staff from the staff app.
 * There is no card provider behind it any more (0020 dropped its columns).
 *
 * On the platform connection. A company reads its own row through the tenant
 * connection instead — see {@link TenantSubscriptionReader} — and can write
 * none of it.
 */

export interface Subscription {
  tenantId: string;
  status: SubscriptionStatus;
  plan: TenantPlan;
  trialEndsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class BillingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async find(tenantId: string): Promise<Subscription | undefined> {
    const row = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    return row === undefined ? undefined : toSubscription(row);
  }

  /**
   * Starts a company's record, or leaves the one that is there.
   *
   * Called when a company is onboarded, so every company has a row from the
   * first day.
   */
  async start(input: {
    tenantId: string;
    plan: TenantPlan;
    trialEndsAt: Date | null;
    /** `active` unless said otherwise. */
    status?: SubscriptionStatus;
  }): Promise<Subscription> {
    const row = await this.db
      .insertInto('subscriptions')
      .values({
        tenant_id: input.tenantId,
        plan: input.plan,
        status: input.status ?? 'active',
        trial_ends_at: input.trialEndsAt,
      })
      .onConflict((conflict) => conflict.column('tenant_id').doNothing())
      .returningAll()
      .executeTakeFirst();

    // `doNothing` returns nothing when the row was already there — in which
    // case there is certainly one to read back.
    if (row !== undefined) {
      return toSubscription(row);
    }
    return (await this.find(input.tenantId))!;
  }

  /** Every field optional; an absent one is left alone. */
  async update(
    tenantId: string,
    input: {
      status?: SubscriptionStatus;
      plan?: TenantPlan;
      trialEndsAt?: Date | null;
    },
  ): Promise<Subscription | undefined> {
    const row = await this.db
      .updateTable('subscriptions')
      .set({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.trialEndsAt === undefined ? {} : { trial_ends_at: input.trialEndsAt }),
      })
      .where('tenant_id', '=', tenantId)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toSubscription(row);
  }

  /**
   * Every company, for the dashboard and for the platform's own totals. Test
   * companies (0077) are left out: they are never billed or counted.
   */
  async list(): Promise<Subscription[]> {
    return (
      await this.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('tenant_id', 'not in', (qb) =>
          qb.selectFrom('tenants').select('id').where('is_test', '=', true),
        )
        .orderBy('created_at', 'asc')
        .execute()
    ).map(toSubscription);
  }
}

/**
 * A company's own subscription, through the tenant connection.
 *
 * Read-only by privilege as well as by API: the runtime role holds `select`
 * and nothing else, so a bug in a handler cannot write a company onto a plan
 * it is not on.
 */
export class TenantSubscriptionReader {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantId: string,
  ) {}

  async find(): Promise<Subscription | undefined> {
    const row = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();

    return row === undefined ? undefined : toSubscription(row);
  }
}

function toSubscription(row: Selectable<SubscriptionsTable>): Subscription {
  return {
    tenantId: row.tenant_id,
    status: row.status,
    plan: row.plan,
    trialEndsAt: row.trial_ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
