import type { PlatformUserId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type {
  Database,
  OveragePolicy,
  PlanAllowancesTable,
  ReconciliationStatus,
  StorageReconciliationsTable,
  TenantPlan,
  TenantStorageSamplesTable,
  UsageCategory,
} from '../schema.js';

/**
 * What a company is allowed, what they have used, and what that has cost
 * (P16).
 *
 * All of it runs on the platform connection. The allowances belong to a plan
 * rather than to a company; the samples and reconciliations span every company
 * at once, which is the point of them. A company reads its own history through
 * the tenant connection instead — see {@link TenantStorageHistory}.
 */

export interface PlanAllowance {
  plan: TenantPlan;
  /** Null is uncapped. */
  storageBytes: number | null;
  /** Null keeps media for ever. */
  retentionDays: number | null;
  overage: OveragePolicy;
  warnAtPercent: number;
  /** The rest of what a plan allows (P17). Null is uncapped, as above. */
  seats: number | null;
  submissionsPerMonth: number | null;
  /** What it costs, for a screen to show. The provider does the arithmetic. */
  priceCents: number | null;
  currency: string | null;
  providerPriceMonthly: string | null;
  providerPriceYearly: string | null;
  updatedAt: Date;
}

export interface StorageSample {
  tenantId: string;
  /** `YYYY-MM-DD`. */
  sampledOn: string;
  bytes: number;
  objects: number;
  byCategory: Record<string, number>;
  allowanceBytes: number | null;
  overageBytes: number | null;
  classAOperations: number | null;
  classBOperations: number | null;
}

export interface Reconciliation {
  id: string;
  tenantId: string;
  ranAt: Date;
  ledgerBytes: number;
  ledgerObjects: number;
  cloudflareBytes: number | null;
  cloudflareObjects: number | null;
  cloudflareSampledAt: Date | null;
  driftBytes: number | null;
  status: ReconciliationStatus;
  note: string | null;
}

export class StorageMeteringRepository {
  constructor(private readonly db: Kysely<Database>) {}

  // -------------------------------------------------------------------------
  // Allowances
  // -------------------------------------------------------------------------

  async allowances(): Promise<PlanAllowance[]> {
    return (await this.db.selectFrom('plan_allowances').selectAll().orderBy('plan').execute()).map(
      toAllowance,
    );
  }

  async allowanceFor(plan: TenantPlan): Promise<PlanAllowance | undefined> {
    const row = await this.db
      .selectFrom('plan_allowances')
      .selectAll()
      .where('plan', '=', plan)
      .executeTakeFirst();

    return row === undefined ? undefined : toAllowance(row);
  }

  /**
   * Changes what a plan allows.
   *
   * Every field is optional and only what is passed is written, so raising one
   * company's storage does not silently reset the retention window somebody
   * agreed with a customer.
   */
  async setAllowance(
    plan: TenantPlan,
    input: {
      storageBytes?: number | null | undefined;
      retentionDays?: number | null | undefined;
      overage?: OveragePolicy | undefined;
      warnAtPercent?: number | undefined;
      seats?: number | null | undefined;
      submissionsPerMonth?: number | null | undefined;
      priceCents?: number | null | undefined;
      currency?: string | null | undefined;
      providerPriceMonthly?: string | null | undefined;
      providerPriceYearly?: string | null | undefined;
      updatedBy: PlatformUserId | string | null;
    },
  ): Promise<PlanAllowance | undefined> {
    const row = await this.db
      .updateTable('plan_allowances')
      .set({
        ...(input.storageBytes === undefined ? {} : { storage_bytes: input.storageBytes }),
        ...(input.retentionDays === undefined ? {} : { retention_days: input.retentionDays }),
        ...(input.overage === undefined ? {} : { overage: input.overage }),
        ...(input.warnAtPercent === undefined ? {} : { warn_at_percent: input.warnAtPercent }),
        ...(input.seats === undefined ? {} : { seats: input.seats }),
        ...(input.submissionsPerMonth === undefined
          ? {}
          : { submissions_per_month: input.submissionsPerMonth }),
        ...(input.priceCents === undefined ? {} : { price_cents: input.priceCents }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.providerPriceMonthly === undefined
          ? {}
          : { provider_price_monthly: input.providerPriceMonthly }),
        ...(input.providerPriceYearly === undefined
          ? {}
          : { provider_price_yearly: input.providerPriceYearly }),
        updated_by: input.updatedBy ?? null,
      })
      .where('plan', '=', plan)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toAllowance(row);
  }

  // -------------------------------------------------------------------------
  // Samples
  // -------------------------------------------------------------------------

  /**
   * Records a company's use for one day.
   *
   * Keyed on the day rather than the moment, and upserted, so running the
   * sampler twice in a night leaves one row rather than two — and a run that
   * happens after a purge corrects the day rather than adding to it.
   */
  async recordSample(input: {
    tenantId: string;
    sampledOn: string;
    bytes: number;
    objects: number;
    byCategory: Record<string, number>;
    allowanceBytes: number | null;
    classAOperations?: number | null;
    classBOperations?: number | null;
  }): Promise<StorageSample> {
    const overage =
      input.allowanceBytes === null ? null : Math.max(0, input.bytes - input.allowanceBytes);

    const values = {
      tenant_id: input.tenantId,
      sampled_on: input.sampledOn,
      bytes: input.bytes,
      objects: input.objects,
      by_category: JSON.stringify(input.byCategory) as never,
      allowance_bytes: input.allowanceBytes,
      overage_bytes: overage,
      class_a_operations: input.classAOperations ?? null,
      class_b_operations: input.classBOperations ?? null,
    };

    const row = await this.db
      .insertInto('tenant_storage_samples')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'sampled_on']).doUpdateSet({
          bytes: values.bytes,
          objects: values.objects,
          by_category: values.by_category,
          allowance_bytes: values.allowance_bytes,
          overage_bytes: values.overage_bytes,
          // Only overwrite what Cloudflare said when this run has something to
          // say. A sampler run with no analytics must not erase the numbers an
          // earlier reconciliation wrote.
          ...(values.class_a_operations === null
            ? {}
            : { class_a_operations: values.class_a_operations }),
          ...(values.class_b_operations === null
            ? {}
            : { class_b_operations: values.class_b_operations }),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toSample(row);
  }

  /** One company's trend, newest first. */
  async samplesFor(tenantId: string, days = 90): Promise<StorageSample[]> {
    return (
      await this.db
        .selectFrom('tenant_storage_samples')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('sampled_on', '>=', sql<string>`(current_date - make_interval(days => ${days}))`)
        .orderBy('sampled_on', 'desc')
        .execute()
    ).map(toSample);
  }

  /**
   * What every company was using on the most recent day sampled.
   *
   * One query for the platform-wide totals and the projected bill, rather than
   * a read per company.
   */
  async latestSamples(): Promise<StorageSample[]> {
    return (
      await this.db
        .selectFrom('tenant_storage_samples')
        .selectAll()
        .distinctOn('tenant_id')
        .orderBy('tenant_id')
        .orderBy('sampled_on', 'desc')
        .execute()
    ).map(toSample);
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  async recordReconciliation(input: {
    tenantId: string;
    ledgerBytes: number;
    ledgerObjects: number;
    cloudflareBytes: number | null;
    cloudflareObjects: number | null;
    cloudflareSampledAt: Date | null;
    status: ReconciliationStatus;
    note?: string | null;
  }): Promise<Reconciliation> {
    const row = await this.db
      .insertInto('storage_reconciliations')
      .values({
        tenant_id: input.tenantId,
        ledger_bytes: input.ledgerBytes,
        ledger_objects: input.ledgerObjects,
        cloudflare_bytes: input.cloudflareBytes,
        cloudflare_objects: input.cloudflareObjects,
        cloudflare_sampled_at: input.cloudflareSampledAt,
        drift_bytes:
          input.cloudflareBytes === null ? null : input.ledgerBytes - input.cloudflareBytes,
        status: input.status,
        note: input.note ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toReconciliation(row);
  }

  /** The most recent result for each company, for the dashboard. */
  async latestReconciliations(): Promise<Reconciliation[]> {
    return (
      await this.db
        .selectFrom('storage_reconciliations')
        .selectAll()
        .distinctOn('tenant_id')
        .orderBy('tenant_id')
        .orderBy('ran_at', 'desc')
        .execute()
    ).map(toReconciliation);
  }

  async reconciliationsFor(tenantId: string, limit = 30): Promise<Reconciliation[]> {
    return (
      await this.db
        .selectFrom('storage_reconciliations')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('ran_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toReconciliation);
  }

  // -------------------------------------------------------------------------
  // Making a nightly job nightly
  // -------------------------------------------------------------------------

  /**
   * Claims a turn at a recurring task, or says somebody else has it.
   *
   * There is no cron in this system and no scheduler process: the worker runs
   * housekeeping on a timer and several workers run at once. The conditional
   * update is the whole mechanism — exactly one worker's statement matches, and
   * the rest are told no.
   *
   * `every` is how long must have passed since the last *start*, not the last
   * finish, so a task that dies holding its turn is retried on the next tick
   * after the interval rather than never.
   */
  async claimTask(task: string, every: { hours: number }, workerId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('scheduled_task_runs')
      .set({ last_run_at: sql<Date>`now()`, claimed_by: workerId, last_finished_at: null })
      .where('task', '=', task)
      .where('last_run_at', '<=', sql<Date>`now() - make_interval(hours => ${every.hours})`)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** Records that a claimed task finished, and whether it went wrong. */
  async finishTask(task: string, error?: string): Promise<void> {
    await this.db
      .updateTable('scheduled_task_runs')
      .set({ last_finished_at: sql<Date>`now()`, last_error: error?.slice(0, 2_000) ?? null })
      .where('task', '=', task)
      .execute();
  }

  async taskRuns(): Promise<
    { task: string; lastRunAt: Date; lastFinishedAt: Date | null; lastError: string | null }[]
  > {
    return (
      await this.db.selectFrom('scheduled_task_runs').selectAll().orderBy('task').execute()
    ).map((row) => ({
      task: row.task,
      lastRunAt: row.last_run_at,
      lastFinishedAt: row.last_finished_at,
      lastError: row.last_error,
    }));
  }
}

function toAllowance(row: Selectable<PlanAllowancesTable>): PlanAllowance {
  return {
    plan: row.plan,
    storageBytes: row.storage_bytes === null ? null : Number(row.storage_bytes),
    retentionDays: row.retention_days,
    overage: row.overage,
    warnAtPercent: row.warn_at_percent,
    seats: row.seats,
    submissionsPerMonth: row.submissions_per_month,
    priceCents: row.price_cents,
    currency: row.currency,
    providerPriceMonthly: row.provider_price_monthly,
    providerPriceYearly: row.provider_price_yearly,
    updatedAt: row.updated_at,
  };
}

function toSample(row: Selectable<TenantStorageSamplesTable>): StorageSample {
  return {
    tenantId: row.tenant_id,
    sampledOn: dayString(row.sampled_on),
    bytes: Number(row.bytes),
    objects: row.objects,
    // `Jsonb` is a write-side wrapper; what comes back is the object itself.
    byCategory: row.by_category as unknown as Record<string, number>,
    allowanceBytes: row.allowance_bytes === null ? null : Number(row.allowance_bytes),
    overageBytes: row.overage_bytes === null ? null : Number(row.overage_bytes),
    classAOperations: row.class_a_operations === null ? null : Number(row.class_a_operations),
    classBOperations: row.class_b_operations === null ? null : Number(row.class_b_operations),
  };
}

/**
 * A `date` column as `YYYY-MM-DD`.
 *
 * The driver parses `date` into a `Date` at **local** midnight, not UTC, so
 * `toISOString` would move the day backwards by the offset — turning the first
 * of the month into the last of the previous one everywhere east of Greenwich,
 * on a row P17 bills from. The parts are read off the local date instead,
 * which is the calendar day Postgres stored.
 */
function dayString(value: unknown): string {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${String(value.getFullYear())}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function toReconciliation(row: Selectable<StorageReconciliationsTable>): Reconciliation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ranAt: row.ran_at,
    ledgerBytes: Number(row.ledger_bytes),
    ledgerObjects: row.ledger_objects,
    cloudflareBytes: row.cloudflare_bytes === null ? null : Number(row.cloudflare_bytes),
    cloudflareObjects: row.cloudflare_objects,
    cloudflareSampledAt: row.cloudflare_sampled_at,
    driftBytes: row.drift_bytes === null ? null : Number(row.drift_bytes),
    status: row.status,
    note: row.note,
  };
}

/**
 * A company's own history, through the tenant connection.
 *
 * P16 shows a company the same numbers the platform sees, so this exists
 * separately from the repository above rather than being reached by handing a
 * tenant id to a platform read. The company holds `select` on the samples and
 * nothing else; the reconciliation is ours.
 */
export class TenantStorageHistory {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantId: string,
  ) {}

  async samples(days = 90): Promise<StorageSample[]> {
    return (
      await this.db
        .selectFrom('tenant_storage_samples')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('sampled_on', '>=', sql<string>`(current_date - make_interval(days => ${days}))`)
        .orderBy('sampled_on', 'desc')
        .execute()
    ).map(toSample);
  }
}

/** The categories a sample's `byCategory` is keyed by, for a caller building one. */
export type SampleCategories = Partial<Record<UsageCategory, number>>;
