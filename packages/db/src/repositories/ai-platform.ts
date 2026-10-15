import type { PlatformUserId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type {
  AiHelpArticlesTable,
  AiHelpArticleStatus,
  AiLevel,
  AiPlanPoliciesTable,
  AiPolicyMode,
  AiQuotaMode,
  AiTenantPoliciesTable,
  Database,
  TenantPlan,
} from '../schema.js';
import { dayKey, micros } from './ai-usage.js';

/**
 * What the platform decides about the assistant, and what it can see of its
 * use across every company (docs/ai; ADR-0001). Owner connection throughout:
 * plan policies, the help library and the deployment's own budget belong to
 * no company, and the usage report reads every company at once.
 */

/** The policy fields a plan and a company override share. Money in USD micros. */
export interface AiPolicyFields {
  level: AiLevel;
  quotaMode: AiQuotaMode | null;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  perUserDailyLimit: number | null;
  perUserMonthlyLimit: number | null;
  unlimitedMessages: boolean;
  monthlyCostCapMicrousd: number | null;
  /** Pooled tokens per UTC day and month; null is no token limit (ADR-0002 D5). */
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolSteps: number;
  maxProviderCalls: number;
  allowHistory: boolean;
  retentionDays: number;
}

export interface AiPlanPolicy extends AiPolicyFields {
  plan: TenantPlan;
  version: number;
  updatedAt: Date;
  updatedBy: PlatformUserId | null;
}

export interface AiTenantPolicy extends AiPolicyFields {
  tenantId: string;
  mode: AiPolicyMode;
  companyDataToProvider: boolean;
  version: number;
  reason: string | null;
  updatedAt: Date;
  updatedBy: PlatformUserId | null;
}

export class AiPolicyVersionConflictError extends Error {
  constructor(readonly currentVersion: number | null) {
    super('The policy changed since it was read.');
    this.name = 'AiPolicyVersionConflictError';
  }
}

export interface AiHelpArticle {
  articleKey: string;
  locale: string;
  module: string;
  title: string;
  summary: string;
  body: string;
  keywords: string[];
  appRoute: string | null;
  helpUrl: string | null;
  feature: string | null;
  minPermission: string | null;
  sourceCommit: string | null;
  contentHash: string;
  status: AiHelpArticleStatus;
  updatedAt: Date;
}

export interface UpsertAiHelpArticleInput {
  articleKey: string;
  locale: string;
  module: string;
  title: string;
  summary: string;
  body: string;
  keywords: string[];
  appRoute: string | null;
  helpUrl: string | null;
  feature: string | null;
  minPermission: string | null;
  sourceCommit: string | null;
  contentHash: string;
}

/** One company's month, for the platform's usage report. */
export interface AiTenantUsageRow {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  plan: TenantPlan;
  monthStart: string;
  messagesUsed: number;
  messagesReserved: number;
  /** Input plus output tokens this month (ADR-0002 D5). */
  tokensUsed: number;
  tokensReserved: number;
  providerCalls: number;
  failedCalls: number;
  spentMicrousd: number;
  reservedMicrousd: number;
  unknownMicrousd: number;
}

export class AiPlatformRepository {
  constructor(private readonly db: Kysely<Database>) {}

  // -------------------------------------------------------------------------
  // Plan policies
  // -------------------------------------------------------------------------

  async planPolicies(): Promise<AiPlanPolicy[]> {
    const rows = await this.db.selectFrom('ai_plan_policies').selectAll().orderBy('plan').execute();
    return rows.map(toPlanPolicy);
  }

  async planPolicy(plan: TenantPlan): Promise<AiPlanPolicy | undefined> {
    const row = await this.db
      .selectFrom('ai_plan_policies')
      .selectAll()
      .where('plan', '=', plan)
      .executeTakeFirst();
    return row === undefined ? undefined : toPlanPolicy(row);
  }

  /**
   * Replaces a plan's policy whole, if nobody else has since the caller read
   * version `expectedVersion`. The whole policy, not a patch: a quota mode and
   * its limits only make sense together.
   */
  async setPlanPolicy(
    plan: TenantPlan,
    policy: AiPolicyFields,
    options: { expectedVersion: number; updatedBy: PlatformUserId | string | null },
  ): Promise<AiPlanPolicy> {
    const row = await this.db
      .updateTable('ai_plan_policies')
      .set({
        ...policyColumns(policy),
        version: options.expectedVersion + 1,
        updated_at: sql`now()`,
        updated_by: options.updatedBy,
      })
      .where('plan', '=', plan)
      .where('version', '=', options.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      const current = await this.planPolicy(plan);
      throw new AiPolicyVersionConflictError(current?.version ?? null);
    }
    return toPlanPolicy(row);
  }

  // -------------------------------------------------------------------------
  // Company overrides
  // -------------------------------------------------------------------------

  async tenantPolicy(tenantId: string): Promise<AiTenantPolicy | undefined> {
    const row = await this.db
      .selectFrom('ai_tenant_policies')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : toTenantPolicy(row);
  }

  /**
   * Writes a company's override. `expectedVersion` null means "no row yet";
   * anything else must match the row's version or the write is refused, so
   * two admins editing the same company do not silently overwrite each other.
   */
  async setTenantPolicy(
    tenantId: string,
    input: {
      mode: AiPolicyMode;
      policy: AiPolicyFields;
      companyDataToProvider: boolean;
      reason: string | null;
      expectedVersion: number | null;
      updatedBy: PlatformUserId | string | null;
    },
  ): Promise<AiTenantPolicy> {
    if (input.expectedVersion === null) {
      const inserted = await this.db
        .insertInto('ai_tenant_policies')
        .values({
          tenant_id: tenantId,
          mode: input.mode,
          ...policyColumns(input.policy),
          company_data_to_provider: input.companyDataToProvider,
          reason: input.reason,
          updated_by: input.updatedBy,
        })
        .onConflict((oc) => oc.column('tenant_id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted === undefined) {
        const current = await this.tenantPolicy(tenantId);
        throw new AiPolicyVersionConflictError(current?.version ?? null);
      }
      return toTenantPolicy(inserted);
    }

    const row = await this.db
      .updateTable('ai_tenant_policies')
      .set({
        mode: input.mode,
        ...policyColumns(input.policy),
        company_data_to_provider: input.companyDataToProvider,
        reason: input.reason,
        version: input.expectedVersion + 1,
        updated_at: sql`now()`,
        updated_by: input.updatedBy,
      })
      .where('tenant_id', '=', tenantId)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      const current = await this.tenantPolicy(tenantId);
      throw new AiPolicyVersionConflictError(current?.version ?? null);
    }
    return toTenantPolicy(row);
  }

  // -------------------------------------------------------------------------
  // The deployment's own budget
  // -------------------------------------------------------------------------

  /**
   * Reserves `amount` USD micros of the month's platform budget, or refuses.
   * The upsert takes the row lock, so two requests at the last dollar
   * serialise and the second is refused.
   */
  async reserveGlobalBudget(
    monthStart: string,
    amount: number,
    capMicrousd: number,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('ai_platform_cost_periods')
        .values({ period_start_utc: monthStart })
        .onConflict((oc) => oc.column('period_start_utc').doUpdateSet({ updated_at: sql`now()` }))
        .returningAll()
        .executeTakeFirstOrThrow();
      const committed =
        micros(row.reserved_microusd) + micros(row.spent_microusd) + micros(row.unknown_microusd);
      if (committed + amount > capMicrousd) {
        return false;
      }
      await trx
        .updateTable('ai_platform_cost_periods')
        .set({ reserved_microusd: sql`reserved_microusd + ${amount}`, updated_at: sql`now()` })
        .where('period_start_utc', '=', monthStart)
        .execute();
      return true;
    });
  }

  /** Gives back `reserved`, records `spent` and `unknown`. Idempotent per settlement, not per call. */
  async settleGlobalBudget(
    monthStart: string,
    change: { reserved: number; spent: number; unknown: number },
  ): Promise<void> {
    await this.db
      .insertInto('ai_platform_cost_periods')
      .values({ period_start_utc: monthStart })
      .onConflict((oc) => oc.column('period_start_utc').doNothing())
      .execute();
    await this.db
      .updateTable('ai_platform_cost_periods')
      .set({
        reserved_microusd: sql`greatest(0, reserved_microusd - ${change.reserved})`,
        spent_microusd: sql`spent_microusd + ${change.spent}`,
        unknown_microusd: sql`greatest(0, unknown_microusd + ${change.unknown})`,
        updated_at: sql`now()`,
      })
      .where('period_start_utc', '=', monthStart)
      .execute();
  }

  async globalBudget(
    monthStart: string,
  ): Promise<{ reserved: number; spent: number; unknown: number }> {
    const row = await this.db
      .selectFrom('ai_platform_cost_periods')
      .selectAll()
      .where('period_start_utc', '=', monthStart)
      .executeTakeFirst();
    return {
      reserved: micros(row?.reserved_microusd ?? 0),
      spent: micros(row?.spent_microusd ?? 0),
      unknown: micros(row?.unknown_microusd ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Help articles
  // -------------------------------------------------------------------------

  async helpArticles(options: { includeDisabled?: boolean } = {}): Promise<AiHelpArticle[]> {
    let query = this.db.selectFrom('ai_help_articles').selectAll();
    if (options.includeDisabled !== true) {
      query = query.where('status', '=', 'published');
    }
    const rows = await query.orderBy('article_key').orderBy('locale').execute();
    return rows.map(toArticle);
  }

  /**
   * Writes the articles the manifest holds, touching only the ones whose
   * content changed, and disables any that the manifest no longer lists.
   * Returns how many were written and how many disabled.
   */
  async syncHelpArticles(
    articles: UpsertAiHelpArticleInput[],
  ): Promise<{ written: number; disabled: number }> {
    const existing = await this.helpArticles({ includeDisabled: true });
    const byKey = new Map(existing.map((row) => [`${row.articleKey}:${row.locale}`, row]));
    let written = 0;

    for (const article of articles) {
      const current = byKey.get(`${article.articleKey}:${article.locale}`);
      if (current?.contentHash === article.contentHash && current.status === 'published') {
        continue;
      }
      await this.db
        .insertInto('ai_help_articles')
        .values({
          article_key: article.articleKey,
          locale: article.locale,
          module: article.module,
          title: article.title,
          summary: article.summary,
          body: article.body,
          keywords: article.keywords,
          app_route: article.appRoute,
          help_url: article.helpUrl,
          feature: article.feature,
          min_permission: article.minPermission,
          source_commit: article.sourceCommit,
          content_hash: article.contentHash,
          status: 'published',
        })
        .onConflict((oc) =>
          oc.columns(['article_key', 'locale']).doUpdateSet({
            module: article.module,
            title: article.title,
            summary: article.summary,
            body: article.body,
            keywords: article.keywords,
            app_route: article.appRoute,
            help_url: article.helpUrl,
            feature: article.feature,
            min_permission: article.minPermission,
            source_commit: article.sourceCommit,
            content_hash: article.contentHash,
            status: 'published',
            updated_at: sql`now()`,
          }),
        )
        .execute();
      written += 1;
    }

    const listed = new Set(articles.map((article) => `${article.articleKey}:${article.locale}`));
    const gone = existing.filter(
      (row) => row.status === 'published' && !listed.has(`${row.articleKey}:${row.locale}`),
    );
    for (const row of gone) {
      await this.db
        .updateTable('ai_help_articles')
        .set({ status: 'disabled', updated_at: sql`now()` })
        .where('article_key', '=', row.articleKey)
        .where('locale', '=', row.locale)
        .execute();
    }

    return { written, disabled: gone.length };
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /** Every company's use of the assistant in one UTC month, with its spend. */
  async usageByTenant(monthStart: string): Promise<AiTenantUsageRow[]> {
    const rows = await this.db
      .selectFrom('tenants')
      .leftJoin('ai_usage_periods', (join) =>
        join
          .onRef('ai_usage_periods.tenant_id', '=', 'tenants.id')
          .onRef('ai_usage_periods.subject_id', '=', 'tenants.id')
          .on('ai_usage_periods.subject_type', '=', 'tenant')
          .on('ai_usage_periods.period_type', '=', 'month')
          .on('ai_usage_periods.period_start_utc', '=', monthStart),
      )
      .leftJoin('ai_cost_periods', (join) =>
        join
          .onRef('ai_cost_periods.tenant_id', '=', 'tenants.id')
          .on('ai_cost_periods.period_start_utc', '=', monthStart),
      )
      .leftJoin('ai_token_periods', (join) =>
        join
          .onRef('ai_token_periods.tenant_id', '=', 'tenants.id')
          .onRef('ai_token_periods.subject_id', '=', 'tenants.id')
          .on('ai_token_periods.subject_type', '=', 'tenant')
          .on('ai_token_periods.period_type', '=', 'month')
          .on('ai_token_periods.period_start_utc', '=', monthStart),
      )
      .select([
        'ai_token_periods.used_tokens as used_tokens',
        'ai_token_periods.reserved_tokens as reserved_tokens',
        'tenants.id as tenant_id',
        'tenants.name as tenant_name',
        'tenants.slug as tenant_slug',
        'tenants.plan as plan',
        'ai_usage_periods.used_messages as used_messages',
        'ai_usage_periods.reserved_messages as reserved_messages',
        'ai_cost_periods.spent_microusd as spent_microusd',
        'ai_cost_periods.reserved_microusd as reserved_microusd',
        'ai_cost_periods.unknown_microusd as unknown_microusd',
        sql<string>`(
          select count(*) from ai_provider_calls c
          where c.tenant_id = tenants.id
            and c.started_at >= ${monthStart}::date
            and c.started_at < (${monthStart}::date + interval '1 month')
        )`.as('provider_calls'),
        sql<string>`(
          select count(*) from ai_provider_calls c
          where c.tenant_id = tenants.id
            and c.status <> 'success'
            and c.started_at >= ${monthStart}::date
            and c.started_at < (${monthStart}::date + interval '1 month')
        )`.as('failed_calls'),
      ])
      .where('tenants.deleted_at', 'is', null)
      .orderBy('tenants.name')
      .execute();

    return rows
      .filter(
        (row) =>
          row.used_messages !== null ||
          row.spent_microusd !== null ||
          Number(row.provider_calls) > 0,
      )
      .map((row) => ({
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        tenantSlug: row.tenant_slug,
        plan: row.plan,
        monthStart,
        messagesUsed: row.used_messages ?? 0,
        messagesReserved: row.reserved_messages ?? 0,
        tokensUsed: micros(row.used_tokens ?? 0),
        tokensReserved: micros(row.reserved_tokens ?? 0),
        providerCalls: Number(row.provider_calls),
        failedCalls: Number(row.failed_calls),
        spentMicrousd: micros(row.spent_microusd ?? 0),
        reservedMicrousd: micros(row.reserved_microusd ?? 0),
        unknownMicrousd: micros(row.unknown_microusd ?? 0),
      }));
  }

  /** One company's counters and spend for the platform's company page. */
  async tenantUsage(
    tenantId: string,
    periods: { day: string; month: string },
  ): Promise<{
    day: { used: number; reserved: number };
    month: { used: number; reserved: number };
    /** Input plus output tokens, company-wide (ADR-0002 D5). */
    tokens: { day: { used: number; reserved: number }; month: { used: number; reserved: number } };
    cost: { spent: number; reserved: number; unknown: number };
    providerCalls: number;
    failedCalls: number;
  }> {
    const counters = await this.db
      .selectFrom('ai_usage_periods')
      .select(['period_type', 'used_messages', 'reserved_messages'])
      .where('tenant_id', '=', tenantId)
      .where('subject_type', '=', 'tenant')
      .where('period_start_utc', 'in', [periods.day, periods.month])
      .execute();
    const day = counters.find((row) => row.period_type === 'day');
    const month = counters.find((row) => row.period_type === 'month');
    const tokenRows = await this.db
      .selectFrom('ai_token_periods')
      .select(['period_type', 'period_start_utc', 'used_tokens', 'reserved_tokens'])
      .where('tenant_id', '=', tenantId)
      .where('subject_type', '=', 'tenant')
      .where('period_start_utc', 'in', [periods.day, periods.month])
      .execute();
    const tokensFor = (period: 'day' | 'month') => {
      const row = tokenRows.find(
        (candidate) =>
          candidate.period_type === period &&
          dayKey(candidate.period_start_utc) === periods[period],
      );
      return {
        used: row === undefined ? 0 : micros(row.used_tokens),
        reserved: row === undefined ? 0 : micros(row.reserved_tokens),
      };
    };
    const cost = await this.db
      .selectFrom('ai_cost_periods')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('period_start_utc', '=', periods.month)
      .executeTakeFirst();
    const calls = await this.db
      .selectFrom('ai_provider_calls')
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) filter (where status <> 'success')`.as('failed'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('started_at', '>=', sql<Date>`${periods.month}::date`)
      .executeTakeFirstOrThrow();

    return {
      day: { used: day?.used_messages ?? 0, reserved: day?.reserved_messages ?? 0 },
      month: { used: month?.used_messages ?? 0, reserved: month?.reserved_messages ?? 0 },
      tokens: { day: tokensFor('day'), month: tokensFor('month') },
      cost: {
        spent: micros(cost?.spent_microusd ?? 0),
        reserved: micros(cost?.reserved_microusd ?? 0),
        unknown: micros(cost?.unknown_microusd ?? 0),
      },
      providerCalls: Number(calls.total),
      failedCalls: Number(calls.failed),
    };
  }

  /** How many reservations across every company are open past their expiry: the reconciler's backlog. */
  async staleReservations(now: Date): Promise<{ count: number; oldest: Date | null }> {
    const row = await this.db
      .selectFrom('ai_message_reservations')
      .select([sql<string>`count(*)`.as('count'), sql<Date | null>`min(expires_at)`.as('oldest')])
      .where('state', 'in', ['reserved', 'uncertain'])
      .where('expires_at', '<=', now)
      .executeTakeFirstOrThrow();
    return { count: Number(row.count), oldest: row.oldest };
  }

  /** Companies with open stale reservations, for the reconciler to visit one by one. */
  async tenantsWithStaleReservations(now: Date, limit = 50): Promise<string[]> {
    const rows = await this.db
      .selectFrom('ai_message_reservations')
      .select('tenant_id')
      .distinct()
      .where('state', 'in', ['reserved', 'uncertain'])
      .where('expires_at', '<=', now)
      .limit(limit)
      .execute();
    return rows.map((row) => row.tenant_id);
  }

  /** Provider calls across every company in a window, for the health screen. */
  async providerHealth(
    since: Date,
  ): Promise<{ calls: number; failed: number; limited: number; averageMs: number | null }> {
    const row = await this.db
      .selectFrom('ai_provider_calls')
      .select([
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) filter (where status <> 'success')`.as('failed'),
        sql<string>`count(*) filter (where error_code = 'rate_limited')`.as('limited'),
        sql<string | null>`avg(extract(epoch from (ended_at - started_at)) * 1000)`.as(
          'average_ms',
        ),
      ])
      .where('started_at', '>=', since)
      .executeTakeFirstOrThrow();
    return {
      calls: Number(row.calls),
      failed: Number(row.failed),
      limited: Number(row.limited),
      averageMs: row.average_ms === null ? null : Math.round(Number(row.average_ms)),
    };
  }
}

function policyColumns(policy: AiPolicyFields) {
  return {
    level: policy.level,
    quota_mode: policy.quotaMode,
    daily_limit: policy.dailyLimit,
    monthly_limit: policy.monthlyLimit,
    per_user_daily_limit: policy.perUserDailyLimit,
    per_user_monthly_limit: policy.perUserMonthlyLimit,
    unlimited_messages: policy.unlimitedMessages,
    monthly_cost_cap_microusd: policy.monthlyCostCapMicrousd,
    daily_token_limit: policy.dailyTokenLimit,
    monthly_token_limit: policy.monthlyTokenLimit,
    max_input_tokens: policy.maxInputTokens,
    max_output_tokens: policy.maxOutputTokens,
    max_tool_steps: policy.maxToolSteps,
    max_provider_calls: policy.maxProviderCalls,
    allow_history: policy.allowHistory,
    retention_days: policy.retentionDays,
  };
}

function fields(row: Selectable<AiPlanPoliciesTable> | Selectable<AiTenantPoliciesTable>) {
  return {
    level: row.level,
    quotaMode: row.quota_mode,
    dailyLimit: row.daily_limit,
    monthlyLimit: row.monthly_limit,
    perUserDailyLimit: row.per_user_daily_limit,
    perUserMonthlyLimit: row.per_user_monthly_limit,
    unlimitedMessages: row.unlimited_messages,
    monthlyCostCapMicrousd:
      row.monthly_cost_cap_microusd === null ? null : micros(row.monthly_cost_cap_microusd),
    dailyTokenLimit: row.daily_token_limit === null ? null : micros(row.daily_token_limit),
    monthlyTokenLimit: row.monthly_token_limit === null ? null : micros(row.monthly_token_limit),
    maxInputTokens: row.max_input_tokens,
    maxOutputTokens: row.max_output_tokens,
    maxToolSteps: row.max_tool_steps,
    maxProviderCalls: row.max_provider_calls,
    allowHistory: row.allow_history,
    retentionDays: row.retention_days,
  };
}

function toPlanPolicy(row: Selectable<AiPlanPoliciesTable>): AiPlanPolicy {
  return {
    plan: row.plan,
    ...fields(row),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by as PlatformUserId | null,
  };
}

function toTenantPolicy(row: Selectable<AiTenantPoliciesTable>): AiTenantPolicy {
  return {
    tenantId: row.tenant_id,
    mode: row.mode,
    ...fields(row),
    companyDataToProvider: row.company_data_to_provider,
    version: row.version,
    reason: row.reason,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by as PlatformUserId | null,
  };
}

function toArticle(row: Selectable<AiHelpArticlesTable>): AiHelpArticle {
  return {
    articleKey: row.article_key,
    locale: row.locale,
    module: row.module,
    title: row.title,
    summary: row.summary,
    body: row.body,
    keywords: row.keywords,
    appRoute: row.app_route,
    helpUrl: row.help_url,
    feature: row.feature,
    minPermission: row.min_permission,
    sourceCommit: row.source_commit,
    contentHash: row.content_hash,
    status: row.status,
    updatedAt: row.updated_at,
  };
}
