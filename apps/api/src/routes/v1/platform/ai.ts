import {
  AI_ANSWER_SOURCES,
  AI_DATA_CLASSES,
  AI_LEVELS,
  AI_POLICY_MODES,
  AI_PROVIDERS,
  AI_QUOTA_MODES,
  aiPolicySchema,
  toPlatformUserId,
} from '@integr8/core';
import {
  AiMemberLimitsVersionConflictError,
  AiPolicyVersionConflictError,
  AiSharesOverTotalError,
  getPlatformDataSource,
  TENANT_PLANS,
  type AiPlanPolicy,
  type AiTenantPolicy,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import {
  AI_MAX_LEVEL_SERVED,
  forgetAiPolicy,
  resolveEffectiveAiPolicy,
} from '../../../ai/policy.js';
import { aiConfiguration } from '../../../ai/configuration.js';
import { periodKeysAt } from '../../../ai/periods.js';
import { approvedDataClasses, providerStatus } from '../../../ai/providers/index.js';
import { providerPausedFor } from '../../../ai/providers/pause.js';
import { aiMemberLimitsChanged, aiSharesOverTotal } from '../../../ai/errors.js';
import { conflict, notFound, unprocessable } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { platformListSchema } from './schemas.js';

/**
 * What the platform decides about the assistant (docs/ai §5.2; ADR-0001).
 *
 * Plan defaults and company overrides are the only two places the assistant's
 * level and limits are set, and both are set here, by a platform token, with
 * before-and-after values in the platform audit log. A company reads its own
 * allowance through `/v1/ai/capabilities` and changes none of it.
 */

const TAGS = ['platform'];

const policyFieldsSchema = z.object({
  level: z.enum(AI_LEVELS),
  /**
   * Where answers come from: a model, or the help library with no provider
   * (ADR-0002 D9, D10). Optional on a write so an older dashboard cannot
   * change it: left out means "keep what is stored", and `model` for a new row.
   */
  answerSource: z.enum(AI_ANSWER_SOURCES).optional(),
  quotaMode: z.enum(AI_QUOTA_MODES).nullable(),
  dailyLimit: z.number().int().nullable(),
  monthlyLimit: z.number().int().nullable(),
  perUserDailyLimit: z.number().int().nullable(),
  perUserMonthlyLimit: z.number().int().nullable(),
  unlimitedMessages: z.boolean(),
  monthlyCostCapMicrousd: z.number().int().nullable(),
  /**
   * The company's pooled input-plus-output tokens per UTC day and month
   * (ADR-0002 D5). Optional on a write so a dashboard from before token
   * limits cannot clear them: left out means "keep what is stored".
   */
  dailyTokenLimit: z.number().int().nullable().optional(),
  monthlyTokenLimit: z.number().int().nullable().optional(),
  maxInputTokens: z.number().int(),
  maxOutputTokens: z.number().int(),
  maxToolSteps: z.number().int(),
  maxProviderCalls: z.number().int(),
  allowHistory: z.boolean(),
  retentionDays: z.number().int(),
});

/**
 * A written policy with any field newer than the writing dashboard (token
 * limits, the answer source) taken from what is stored.
 */
function keepingNewerFields(
  policy: z.infer<typeof policyFieldsSchema>,
  stored:
    | {
        dailyTokenLimit: number | null;
        monthlyTokenLimit: number | null;
        answerSource: 'model' | 'library';
      }
    | undefined,
) {
  return {
    ...policy,
    answerSource: policy.answerSource ?? stored?.answerSource ?? 'model',
    dailyTokenLimit:
      policy.dailyTokenLimit === undefined
        ? (stored?.dailyTokenLimit ?? null)
        : policy.dailyTokenLimit,
    monthlyTokenLimit:
      policy.monthlyTokenLimit === undefined
        ? (stored?.monthlyTokenLimit ?? null)
        : policy.monthlyTokenLimit,
  };
}

const planPolicySchema = policyFieldsSchema.extend({
  plan: z.enum(TENANT_PLANS),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});

const tenantPolicySchema = policyFieldsSchema.extend({
  mode: z.enum(AI_POLICY_MODES),
  companyDataToProvider: z.boolean(),
  version: z.number().int(),
  reason: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});

const effectivePolicySchema = policyFieldsSchema.extend({
  source: z.enum(['plan', 'custom']),
  /** The level before this build's cap: what the policy says, not what runs. */
  configuredLevel: z.enum(AI_LEVELS),
  offReason: z
    .enum(['global_off', 'plan_off', 'custom_off', 'not_served', 'provider_unconfigured'])
    .nullable(),
  /** Where the company's answers actually come from now (ADR-0002 D9–D12). */
  answersFrom: z.enum(AI_ANSWER_SOURCES),
  /**
   * Why they come from the library, when they do: the policy says so, the
   * server has no provider (`AI_PROVIDER=none`), or its AI settings are
   * incomplete.
   */
  libraryReason: z.enum(['policy', 'no_provider', 'provider_unconfigured']).nullable(),
  companyDataToProvider: z.boolean(),
});

const usageAxisSchema = z.object({ used: z.number().int(), reserved: z.number().int() });

const companyAiSchema = z.object({
  plan: z.enum(TENANT_PLANS),
  planPolicy: planPolicySchema,
  override: tenantPolicySchema.nullable(),
  effective: effectivePolicySchema,
  /** The highest level this deployment serves today. */
  maxLevelServed: z.enum(AI_LEVELS),
  globalEnabled: z.boolean(),
  usage: z.object({
    day: usageAxisSchema,
    month: usageAxisSchema,
    /** Input plus output tokens, company-wide (ADR-0002 D5). */
    tokens: z.object({
      day: z.object({ used: z.number().int(), reserved: z.number().int() }),
      month: z.object({ used: z.number().int(), reserved: z.number().int() }),
    }),
    /** How much of the company's allowance its members' shares add up to, in percent. */
    assignedSharePercent: z.number().int(),
    /** USD micros, this UTC month. */
    cost: z.object({
      spent: z.number().int(),
      reserved: z.number().int(),
      unknown: z.number().int(),
    }),
    providerCalls: z.number().int(),
    failedCalls: z.number().int(),
    dayResetsAt: z.iso.datetime(),
    monthResetsAt: z.iso.datetime(),
  }),
});

export const listAiPlanPoliciesRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/ai/plans',
  operationId: 'listAiPlanPolicies',
  summary: 'What each plan allows of the assistant',
  tags: TAGS,
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The plans, and what this deployment serves.',
      schema: platformListSchema(planPolicySchema).extend({
        maxLevelServed: z.enum(AI_LEVELS),
        globalEnabled: z.boolean(),
      }),
    },
  },
  handler: async (_input, context) => {
    const policies = await getPlatformDataSource().ai.planPolicies();
    return {
      status: 200,
      body: {
        items: policies.map(toPlanPolicy),
        maxLevelServed: AI_MAX_LEVEL_SERVED,
        globalEnabled: context.config.AI_ENABLED,
      },
    };
  },
});

export const setAiPlanPolicyRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/ai/plans/:plan',
  operationId: 'setAiPlanPolicy',
  summary: 'Change what a plan allows of the assistant',
  description:
    'The whole policy, not a patch: a quota mode and its limits only make sense together. `expectedVersion` must be the version last read, or the write is refused with 409 `ai_policy_changed` and the current version. Takes effect for every company inheriting the plan within thirty seconds, and at once on the instance that served this request.',
  tags: TAGS,
  security: 'platform',
  params: z.object({ plan: z.enum(TENANT_PLANS) }),
  query: noSchema,
  body: z.object({
    policy: policyFieldsSchema,
    expectedVersion: z.number().int().positive(),
    reason: z.string().max(500).nullable().optional(),
  }),
  responses: {
    200: { description: 'Saved.', schema: planPolicySchema },
    409: { description: 'Somebody else changed it first (`ai_policy_changed`).' },
    422: { description: 'The policy is inconsistent (`ai_policy_invalid`).' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource().ai;
    const before = await platform.planPolicy(params.plan);
    const policy = parsePolicy(keepingNewerFields(body.policy, before));
    let saved: AiPlanPolicy;
    try {
      saved = await platform.setPlanPolicy(params.plan, policy, {
        expectedVersion: body.expectedVersion,
        updatedBy: toPlatformUserId(context.platform.platformUserId),
      });
    } catch (error) {
      if (error instanceof AiPolicyVersionConflictError) {
        throw conflict(
          'ai_policy_changed',
          `The ${params.plan} policy is at version ${String(error.currentVersion)}; read it again before saving.`,
        );
      }
      throw error;
    }
    forgetAiPolicy();
    await recordPlatformAction(context, {
      action: 'ai.plan_policy_changed',
      targetKind: 'plan',
      targetId: params.plan,
      reason: body.reason ?? null,
      metadata: {
        before: before === undefined ? null : toPlanPolicy(before),
        after: toPlanPolicy(saved),
      },
    });
    return { status: 200, body: toPlanPolicy(saved) };
  },
});

export const getCompanyAiRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/ai',
  operationId: 'getCompanyAi',
  summary: 'A company’s assistant policy, where it comes from, and its usage',
  tags: TAGS,
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The company’s assistant.', schema: companyAiSchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }, context) => {
    return { status: 200, body: await companyAi(params.tenantId, context.config) };
  },
});

export const setCompanyAiRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/companies/:tenantId/ai',
  operationId: 'setCompanyAi',
  summary: 'Set a company’s assistant override, or return it to its plan',
  description:
    '`mode: inherit` follows the plan (the policy fields are kept but ignored); `mode: custom` uses the policy sent, whole. `companyDataToProvider` says whether the company’s own records may be sent to the configured provider for insights and actions; off until somebody here says otherwise. `expectedVersion` is the override’s version last read, or null when the company has none yet. Usage counters are never touched.',
  tags: TAGS,
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({
    mode: z.enum(AI_POLICY_MODES),
    policy: policyFieldsSchema,
    companyDataToProvider: z.boolean(),
    reason: z.string().max(500).nullable(),
    expectedVersion: z.number().int().positive().nullable(),
  }),
  responses: {
    200: { description: 'Saved.', schema: companyAiSchema },
    404: { description: 'No such company.' },
    409: { description: 'Somebody else changed it first (`ai_policy_changed`).' },
    422: { description: 'The policy is inconsistent (`ai_policy_invalid`).' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(params.tenantId);
    if (tenant?.deletedAt !== null) {
      throw notFound(`No company with id ${params.tenantId}`);
    }
    // An inherited policy's fields are not the policy, so they are not held to
    // the policy's consistency rule; a custom one is.
    const before = await platform.ai.tenantPolicy(tenant.id);
    const written = keepingNewerFields(body.policy, before);
    const policy = body.mode === 'custom' ? parsePolicy(written) : written;
    let saved: AiTenantPolicy;
    try {
      saved = await platform.ai.setTenantPolicy(tenant.id, {
        mode: body.mode,
        policy,
        companyDataToProvider: body.companyDataToProvider,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
        updatedBy: toPlatformUserId(context.platform.platformUserId),
      });
    } catch (error) {
      if (error instanceof AiPolicyVersionConflictError) {
        throw conflict(
          'ai_policy_changed',
          `This company's override is at version ${String(error.currentVersion)}; read it again before saving.`,
        );
      }
      throw error;
    }
    forgetAiPolicy(tenant.id);
    await recordPlatformAction(context, {
      action: 'ai.company_policy_changed',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant',
      targetId: tenant.id,
      reason: body.reason,
      metadata: {
        before: before === undefined ? null : toTenantPolicy(before),
        after: toTenantPolicy(saved),
      },
    });
    return { status: 200, body: await companyAi(tenant.id, context.config) };
  },
});

export const aiUsageReportRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/ai/usage',
  operationId: 'aiUsageReport',
  summary: 'Every company’s assistant use and spend in one month',
  tags: TAGS,
  security: 'platform',
  params: noSchema,
  query: z.object({
    /** `YYYY-MM`; this month when absent. */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/u)
      .optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'One row per company that used the assistant.',
      schema: platformListSchema(
        z.object({
          tenantId: z.uuid(),
          tenantName: z.string(),
          tenantSlug: z.string(),
          plan: z.enum(TENANT_PLANS),
          monthStart: z.string(),
          messagesUsed: z.number().int(),
          messagesReserved: z.number().int(),
          tokensUsed: z.number().int(),
          tokensReserved: z.number().int(),
          providerCalls: z.number().int(),
          failedCalls: z.number().int(),
          spentMicrousd: z.number().int(),
          reservedMicrousd: z.number().int(),
          unknownMicrousd: z.number().int(),
        }),
      ).extend({
        monthStart: z.string(),
        global: z.object({
          budgetMicrousd: z.number().int(),
          spentMicrousd: z.number().int(),
          reservedMicrousd: z.number().int(),
          unknownMicrousd: z.number().int(),
        }),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const monthStart =
      query.month === undefined ? periodKeysAt(new Date()).month : `${query.month}-01`;
    const platform = getPlatformDataSource().ai;
    const items = await platform.usageByTenant(monthStart);
    const global = await platform.globalBudget(monthStart);
    return {
      status: 200,
      body: {
        items,
        monthStart,
        global: {
          budgetMicrousd: context.config.AI_GLOBAL_MONTHLY_BUDGET_MICROUSD,
          spentMicrousd: global.spent,
          reservedMicrousd: global.reserved,
          unknownMicrousd: global.unknown,
        },
      },
    };
  },
});

export const aiProvidersRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/ai/providers',
  operationId: 'aiProviders',
  summary: 'Which provider answers, and which are ready to',
  description: 'Configuration facts only. No key, nor any part of one, is ever returned.',
  tags: TAGS,
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The providers.',
      schema: z.object({
        active: z.enum(AI_PROVIDERS),
        globalEnabled: z.boolean(),
        maxLevelServed: z.enum(AI_LEVELS),
        models: z.object({
          help: z.string().nullable(),
          insights: z.string().nullable(),
          agent: z.string().nullable(),
        }),
        /**
         * Whether the active provider can answer at all, and what is wrong
         * when it cannot (ADR-0002 D2). Configuration never stops the
         * server; it turns the assistant off and says so here.
         */
        ready: z.boolean(),
        /**
         * `AI_PROVIDER=none`: no provider by choice. Every company is answered
         * from the help library, and nothing needs fixing (ADR-0002 D12).
         */
        libraryOnly: z.boolean(),
        problems: z.array(z.string()),
        /** The levels that have a model, highest first. */
        servedLevels: z.array(z.enum(['agent', 'insights', 'help'])),
        /** Per level: whether its model has its own price row, and a cached-input rate. */
        prices: z.object({
          help: z.object({ listed: z.boolean(), cachedInputPriced: z.boolean() }),
          insights: z.object({ listed: z.boolean(), cachedInputPriced: z.boolean() }),
          agent: z.object({ listed: z.boolean(), cachedInputPriced: z.boolean() }),
        }),
        /**
         * Seconds this API process still waits before asking the provider
         * again after it said the account's credit is spent (ADR-0002 D8).
         */
        creditPauseSeconds: z.number().int().nullable(),
        providers: z.array(
          z.object({
            id: z.enum(AI_PROVIDERS),
            configured: z.boolean(),
            approvedDataClasses: z.array(z.enum(AI_DATA_CLASSES)),
          }),
        ),
      }),
    },
  },
  handler: (_input, context) => {
    const config = context.config;
    const configuration = aiConfiguration(config);
    const priced = (model: string | null) => {
      if (model === null) {
        return { listed: false, cachedInputPriced: false };
      }
      const price = context.services.ai.prices.priceFor(config.AI_PROVIDER, model);
      return { listed: price.listed, cachedInputPriced: price.cachedInputPerMillion !== null };
    };
    return Promise.resolve({
      status: 200,
      body: {
        active: config.AI_PROVIDER,
        globalEnabled: config.AI_ENABLED,
        maxLevelServed: AI_MAX_LEVEL_SERVED,
        models: {
          help: config.AI_MODEL_HELP ?? null,
          insights: config.AI_MODEL_INSIGHTS ?? null,
          agent: config.AI_MODEL_AGENT ?? null,
        },
        ready: configuration.ready,
        libraryOnly: configuration.libraryOnly,
        problems: configuration.problems,
        servedLevels: configuration.servedLevels,
        prices: {
          help: priced(configuration.models.help),
          insights: priced(configuration.models.insights),
          agent: priced(configuration.models.agent),
        },
        creditPauseSeconds: providerPausedFor(config.AI_PROVIDER),
        // `none` is the absence of a provider, not one to list.
        providers: AI_PROVIDERS.filter((id) => id !== 'none').map((id) => ({
          id,
          configured: providerStatus(id, config),
          approvedDataClasses: approvedDataClasses(id, config),
        })),
      },
    });
  },
});

// ---------------------------------------------------------------------------
// A company's members: shares, numbers and dollar caps (ADR-0002 D6, D7)
// ---------------------------------------------------------------------------

const platformMemberSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  status: z.string(),
  aiEnabled: z.boolean(),
  /** 1–100, or null: no share and so no assistant. */
  sharePercent: z.number().int().nullable(),
  /** USD micros per UTC month; null is no cap of the member's own. Platform only. */
  monthlyCostCapMicrousd: z.number().int().nullable(),
  version: z.number().int().nullable(),
  messages: z.object({ day: z.number().int(), month: z.number().int() }),
  tokens: z.object({ day: z.number().int(), month: z.number().int() }),
  /** USD micros this UTC month, on the member's own ledger. */
  cost: z.object({
    spent: z.number().int(),
    reserved: z.number().int(),
    unknown: z.number().int(),
  }),
});

async function companyMembers(tenantId: string) {
  const periods = periodKeysAt(new Date());
  return withTenant(tenantId, async (tx) => {
    const [members, limits, counters, costs, assigned] = await Promise.all([
      tx.tenantUsers.list(),
      tx.aiMemberLimits.list(),
      tx.aiUsage.memberCounters(periods),
      tx.aiUsage.memberCostPeriods(periods.month),
      tx.aiMemberLimits.assignedPercent(),
    ]);
    return {
      assignedSharePercent: assigned,
      items: members.map((member) => {
        const limit = limits.find((row) => row.userId === member.userId);
        const day = counters.find((row) => row.userId === member.userId && row.period === 'day');
        const month = counters.find(
          (row) => row.userId === member.userId && row.period === 'month',
        );
        const cost = costs.find((row) => row.userId === member.userId);
        return {
          userId: member.userId,
          displayName: member.displayName,
          email: member.email,
          status: member.status,
          aiEnabled: member.aiEnabled,
          sharePercent: limit?.sharePercent ?? null,
          monthlyCostCapMicrousd: limit?.monthlyCostCapMicrousd ?? null,
          version: limit?.version ?? null,
          messages: { day: day?.messagesUsed ?? 0, month: month?.messagesUsed ?? 0 },
          tokens: { day: day?.tokensUsed ?? 0, month: month?.tokensUsed ?? 0 },
          cost: {
            spent: cost?.spent ?? 0,
            reserved: cost?.reserved ?? 0,
            unknown: cost?.unknown ?? 0,
          },
        };
      }),
    };
  });
}

export const listCompanyAiMembersRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/ai/members',
  operationId: 'listCompanyAiMembers',
  summary: 'A company’s members: their assistant shares, use and spend',
  description:
    'Platform only: the numbers behind the percentages the company sees, and each member’s own dollar cap and spend this month (ADR-0002 D7).',
  tags: TAGS,
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The members.',
      schema: z.object({
        assignedSharePercent: z.number().int(),
        items: z.array(platformMemberSchema),
      }),
    },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }) => {
    const tenant = await getPlatformDataSource().tenants.findById(params.tenantId);
    if (tenant?.deletedAt !== null) {
      throw notFound(`No company with id ${params.tenantId}`);
    }
    return { status: 200, body: await companyMembers(tenant.id) };
  },
});

export const setCompanyAiMemberRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/companies/:tenantId/ai/members/:userId',
  operationId: 'setCompanyAiMember',
  summary: 'Set a member’s assistant share or monthly dollar cap',
  description:
    'Either or both; a field left out keeps its value. The share follows the company’s rules (whole percent, 1–100, the company’s total 100 or less); the dollar cap, in USD micros, is the platform’s alone and never shown to the company. `expectedVersion` as for the company’s own route. Recorded in the platform audit log with before and after.',
  tags: TAGS,
  security: 'platform',
  params: z.object({ tenantId: z.uuid(), userId: z.uuid() }),
  query: noSchema,
  body: z.object({
    sharePercent: z.number().int().min(1).max(100).nullable().optional(),
    monthlyCostCapMicrousd: z.number().int().positive().nullable().optional(),
    expectedVersion: z.number().int().positive().nullable(),
    reason: z.string().max(500).nullable(),
  }),
  responses: {
    200: { description: 'The member as they now are.', schema: platformMemberSchema },
    404: { description: 'No such company or member.' },
    409: { description: 'Somebody changed it first (`ai_member_limits_changed`).' },
    422: { description: 'The shares would pass 100% (`ai_shares_over_total`).' },
  },
  handler: async ({ params, body }, context) => {
    const tenant = await getPlatformDataSource().tenants.findById(params.tenantId);
    if (tenant?.deletedAt !== null) {
      throw notFound(`No company with id ${params.tenantId}`);
    }
    const member = await withTenant(tenant.id, (tx) => tx.tenantUsers.findByUserId(params.userId));
    if (member === undefined) {
      throw notFound('No such person in this company.');
    }
    let before;
    let after;
    try {
      [before, after] = await withTenant(tenant.id, async (tx) => {
        const previous = await tx.aiMemberLimits.find(params.userId);
        const saved = await tx.aiMemberLimits.set({
          userId: params.userId,
          ...(body.sharePercent === undefined ? {} : { sharePercent: body.sharePercent }),
          ...(body.monthlyCostCapMicrousd === undefined
            ? {}
            : { monthlyCostCapMicrousd: body.monthlyCostCapMicrousd }),
          expectedVersion: body.expectedVersion,
          updatedBy: context.platform.platformUserId,
        });
        return [previous, saved] as const;
      });
    } catch (error) {
      if (error instanceof AiMemberLimitsVersionConflictError) {
        throw aiMemberLimitsChanged(error.currentVersion);
      }
      if (error instanceof AiSharesOverTotalError) {
        throw aiSharesOverTotal(error.availablePercent);
      }
      throw error;
    }
    forgetAiPolicy(tenant.id);
    await recordPlatformAction(context, {
      action: 'ai.member_limits_changed',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant_user',
      targetId: params.userId,
      reason: body.reason,
      metadata: {
        before:
          before === undefined
            ? null
            : {
                sharePercent: before.sharePercent,
                monthlyCostCapMicrousd: before.monthlyCostCapMicrousd,
              },
        after: {
          sharePercent: after.sharePercent,
          monthlyCostCapMicrousd: after.monthlyCostCapMicrousd,
        },
      },
    });
    const members = await companyMembers(tenant.id);
    const row = members.items.find((item) => item.userId === params.userId);
    if (row === undefined) {
      throw notFound('No such person in this company.');
    }
    return { status: 200, body: row };
  },
});

export const aiHealthRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/ai/health',
  operationId: 'aiHealth',
  summary: 'How the assistant is doing: provider failures, open reservations',
  tags: TAGS,
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The last 24 hours, and what is waiting for the reconciler.',
      schema: z.object({
        window: z.object({
          since: z.iso.datetime(),
          calls: z.number().int(),
          failed: z.number().int(),
          limited: z.number().int(),
          /** Refused because the provider account's credit was spent (ADR-0002 D8). */
          creditExhausted: z.number().int(),
          averageMs: z.number().int().nullable(),
        }),
        staleReservations: z.object({
          count: z.number().int(),
          oldestExpiredAt: z.iso.datetime().nullable(),
        }),
        budget: z.object({
          monthStart: z.string(),
          budgetMicrousd: z.number().int(),
          spentMicrousd: z.number().int(),
          reservedMicrousd: z.number().int(),
          unknownMicrousd: z.number().int(),
        }),
      }),
    },
  },
  handler: async (_input, context) => {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const platform = getPlatformDataSource().ai;
    const window = await platform.providerHealth(since);
    const stale = await platform.staleReservations(now);
    const monthStart = periodKeysAt(now).month;
    const global = await platform.globalBudget(monthStart);
    return {
      status: 200,
      body: {
        window: { since: iso(since), ...window },
        staleReservations: { count: stale.count, oldestExpiredAt: isoOrNull(stale.oldest) },
        budget: {
          monthStart,
          budgetMicrousd: context.config.AI_GLOBAL_MONTHLY_BUDGET_MICROUSD,
          spentMicrousd: global.spent,
          reservedMicrousd: global.reserved,
          unknownMicrousd: global.unknown,
        },
      },
    };
  },
});

export const platformAiRoutes = [
  listAiPlanPoliciesRoute,
  setAiPlanPolicyRoute,
  getCompanyAiRoute,
  setCompanyAiRoute,
  aiUsageReportRoute,
  aiProvidersRoute,
  aiHealthRoute,
  listCompanyAiMembersRoute,
  setCompanyAiMemberRoute,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function companyAi(
  tenantId: string,
  config: Parameters<typeof resolveEffectiveAiPolicy>[1],
): Promise<z.infer<typeof companyAiSchema>> {
  const platform = getPlatformDataSource();
  const tenant = await platform.tenants.findById(tenantId);
  if (tenant?.deletedAt !== null) {
    throw notFound(`No company with id ${tenantId}`);
  }
  const planPolicy = await platform.ai.planPolicy(tenant.plan);
  if (planPolicy === undefined) {
    throw notFound(`No policy for plan ${tenant.plan}`);
  }
  const override = await platform.ai.tenantPolicy(tenant.id);
  // Fresh, not cached: the dashboard has just written it.
  forgetAiPolicy(tenant.id);
  const effective = await resolveEffectiveAiPolicy(tenant.id, config);
  const now = new Date();
  const periods = periodKeysAt(now);
  const usage = await platform.ai.tenantUsage(tenant.id, periods);
  const assignedSharePercent = await withTenant(tenant.id, (tx) =>
    tx.aiMemberLimits.assignedPercent(),
  );
  const { overrideVersion: _version, ...effectiveBody } = effective;
  void _version;
  return {
    plan: tenant.plan,
    planPolicy: toPlanPolicy(planPolicy),
    override: override === undefined ? null : toTenantPolicy(override),
    effective: effectiveBody,
    maxLevelServed: AI_MAX_LEVEL_SERVED,
    globalEnabled: config.AI_ENABLED,
    usage: {
      day: usage.day,
      month: usage.month,
      tokens: usage.tokens,
      assignedSharePercent,
      cost: usage.cost,
      providerCalls: usage.providerCalls,
      failedCalls: usage.failedCalls,
      dayResetsAt: iso(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
      ),
      monthResetsAt: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))),
    },
  };
}

function parsePolicy(policy: z.infer<typeof policyFieldsSchema>) {
  const parsed = aiPolicySchema.safeParse(policy);
  if (!parsed.success) {
    throw aiPolicyInvalid(parsed.error);
  }
  return parsed.data;
}

function aiPolicyInvalid(error: z.ZodError) {
  return unprocessable(
    'ai_policy_invalid',
    `The policy is inconsistent: ${error.issues.map((issue) => issue.message).join(' ')}`,
    error.issues.map((issue) => ({
      field: ['body', 'policy', ...issue.path.map(String)].join('.'),
      code: 'ai_policy_invalid',
      message: issue.message,
    })),
  );
}

function toPlanPolicy(policy: AiPlanPolicy): z.infer<typeof planPolicySchema> {
  return { ...policy, updatedAt: iso(policy.updatedAt) };
}

function toTenantPolicy(policy: AiTenantPolicy): z.infer<typeof tenantPolicySchema> {
  const { tenantId: _tenantId, ...rest } = policy;
  void _tenantId;
  return { ...rest, updatedAt: iso(policy.updatedAt) };
}
