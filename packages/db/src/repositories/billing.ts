import { type Kysely, type Selectable, sql } from 'kysely';
import type {
  BillingEventsTable,
  BillingInterval,
  Database,
  SubscriptionsTable,
  SubscriptionStatus,
  TenantPlan,
} from '../schema.js';

/**
 * What each company is paying for, and what the provider has told us (P17).
 *
 * On the platform connection: a subscription is written by a webhook, which
 * arrives with no company attached and has to find one. A company reads its
 * own row through the tenant connection instead — see
 * {@link TenantSubscriptionReader} — and can write none of it.
 *
 * Nothing here names a provider. Stripe is what we will use; the columns hold
 * whatever the provider calls a customer and a subscription, so a market that
 * needs a different one needs an adapter rather than a migration.
 */

export interface Subscription {
  tenantId: string;
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  status: SubscriptionStatus;
  plan: TenantPlan;
  interval: BillingInterval | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  graceEndsAt: Date | null;
  remindersSent: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BillingEvent {
  id: string;
  provider: string;
  providerEventId: string;
  type: string;
  tenantId: string | null;
  payload: Record<string, unknown>;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
}

export class BillingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  async find(tenantId: string): Promise<Subscription | undefined> {
    const row = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    return row === undefined ? undefined : toSubscription(row);
  }

  /** The company a provider's customer id belongs to, for a webhook to find. */
  async findByCustomer(provider: string, customerId: string): Promise<Subscription | undefined> {
    const row = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_customer_id', '=', customerId)
      .executeTakeFirst();

    return row === undefined ? undefined : toSubscription(row);
  }

  /**
   * Starts a company's billing record, or leaves the one that is there.
   *
   * Called when a company is onboarded, so every company has a row from the
   * first day and the trial clock is written down rather than inferred from
   * the absence of one.
   */
  async start(input: {
    tenantId: string;
    provider: string;
    plan: TenantPlan;
    trialEndsAt: Date | null;
  }): Promise<Subscription> {
    const row = await this.db
      .insertInto('subscriptions')
      .values({
        tenant_id: input.tenantId,
        provider: input.provider,
        plan: input.plan,
        status: 'trialing',
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

  /**
   * Writes what the provider says, and only what it says.
   *
   * Every field is optional and an absent one is left alone, because a webhook
   * for one aspect of a subscription must not blank the fields it says nothing
   * about.
   */
  async update(
    tenantId: string,
    input: {
      providerCustomerId?: string | null;
      providerSubscriptionId?: string | null;
      status?: SubscriptionStatus;
      plan?: TenantPlan;
      interval?: BillingInterval | null;
      currentPeriodStart?: Date | null;
      currentPeriodEnd?: Date | null;
      cancelAtPeriodEnd?: boolean;
      trialEndsAt?: Date | null;
      pastDueSince?: Date | null;
      graceEndsAt?: Date | null;
      remindersSent?: number;
    },
  ): Promise<Subscription | undefined> {
    const row = await this.db
      .updateTable('subscriptions')
      .set({
        ...(input.providerCustomerId === undefined
          ? {}
          : { provider_customer_id: input.providerCustomerId }),
        ...(input.providerSubscriptionId === undefined
          ? {}
          : { provider_subscription_id: input.providerSubscriptionId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.interval === undefined ? {} : { billing_interval: input.interval }),
        ...(input.currentPeriodStart === undefined
          ? {}
          : { current_period_start: input.currentPeriodStart }),
        ...(input.currentPeriodEnd === undefined
          ? {}
          : { current_period_end: input.currentPeriodEnd }),
        ...(input.cancelAtPeriodEnd === undefined
          ? {}
          : { cancel_at_period_end: input.cancelAtPeriodEnd }),
        ...(input.trialEndsAt === undefined ? {} : { trial_ends_at: input.trialEndsAt }),
        ...(input.pastDueSince === undefined ? {} : { past_due_since: input.pastDueSince }),
        ...(input.graceEndsAt === undefined ? {} : { grace_ends_at: input.graceEndsAt }),
        ...(input.remindersSent === undefined ? {} : { reminders_sent: input.remindersSent }),
      })
      .where('tenant_id', '=', tenantId)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toSubscription(row);
  }

  /** Every company, for the dashboard and for the platform's own totals. */
  async list(): Promise<Subscription[]> {
    return (
      await this.db.selectFrom('subscriptions').selectAll().orderBy('created_at', 'asc').execute()
    ).map(toSubscription);
  }

  /** Trials that have run out, for the nightly job that ends them. */
  async lapsedTrials(now = new Date()): Promise<Subscription[]> {
    return (
      await this.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('status', '=', 'trialing')
        .where('trial_ends_at', 'is not', null)
        .where('trial_ends_at', '<=', now)
        .execute()
    ).map(toSubscription);
  }

  /** Companies in dunning, whether or not their grace has run out yet. */
  async inDunning(): Promise<Subscription[]> {
    return (
      await this.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('past_due_since', 'is not', null)
        .where('status', '=', 'past_due')
        .orderBy('grace_ends_at', 'asc')
        .execute()
    ).map(toSubscription);
  }

  // -------------------------------------------------------------------------
  // What the provider told us
  // -------------------------------------------------------------------------

  /**
   * Records a delivery, or says it has been seen before.
   *
   * The unique constraint on `(provider, provider_event_id)` is the whole
   * idempotency mechanism: a duplicate loses the insert and is told so, rather
   * than being applied twice. The request-level idempotency table cannot serve
   * here — it is scoped to a company, and a webhook arrives before we know
   * which company it is about.
   */
  async recordEvent(input: {
    provider: string;
    providerEventId: string;
    type: string;
    tenantId?: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ event: BillingEvent; duplicate: boolean }> {
    const row = await this.db
      .insertInto('billing_events')
      .values({
        provider: input.provider,
        provider_event_id: input.providerEventId,
        type: input.type,
        tenant_id: input.tenantId ?? null,
        payload: JSON.stringify(input.payload) as never,
      })
      .onConflict((conflict) => conflict.columns(['provider', 'provider_event_id']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (row !== undefined) {
      return { event: toEvent(row), duplicate: false };
    }

    const existing = await this.db
      .selectFrom('billing_events')
      .selectAll()
      .where('provider', '=', input.provider)
      .where('provider_event_id', '=', input.providerEventId)
      .executeTakeFirstOrThrow();

    return { event: toEvent(existing), duplicate: true };
  }

  async markEventProcessed(id: string, error?: string): Promise<void> {
    await this.db
      .updateTable('billing_events')
      .set({ processed_at: sql<Date>`now()`, error: error?.slice(0, 2_000) ?? null })
      .where('id', '=', id)
      .execute();
  }

  /** Attaches a company to an event once one has been worked out. */
  async attachEventTenant(id: string, tenantId: string): Promise<void> {
    await this.db
      .updateTable('billing_events')
      .set({ tenant_id: tenantId })
      .where('id', '=', id)
      .execute();
  }

  async recentEvents(limit = 50): Promise<BillingEvent[]> {
    return (
      await this.db
        .selectFrom('billing_events')
        .selectAll()
        .orderBy('received_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toEvent);
  }

  async eventsFor(tenantId: string, limit = 50): Promise<BillingEvent[]> {
    return (
      await this.db
        .selectFrom('billing_events')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('received_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toEvent);
  }
}

/**
 * A company's own subscription, through the tenant connection.
 *
 * Read-only by privilege as well as by API: the runtime role holds `select`
 * and nothing else, so a bug in a handler cannot write a company onto a plan
 * it is not paying for.
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
    provider: row.provider,
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    status: row.status,
    plan: row.plan,
    interval: row.billing_interval,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    trialEndsAt: row.trial_ends_at,
    pastDueSince: row.past_due_since,
    graceEndsAt: row.grace_ends_at,
    remindersSent: row.reminders_sent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: Selectable<BillingEventsTable>): BillingEvent {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    type: row.type,
    tenantId: row.tenant_id,
    payload: row.payload,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    error: row.error,
  };
}
