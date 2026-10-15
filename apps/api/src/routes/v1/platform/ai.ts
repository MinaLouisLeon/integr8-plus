import {
  AI_DATA_CLASSES,
  AI_LEVELS,
  AI_POLICY_MODES,
  AI_PROVIDERS,
  AI_QUOTA_MODES,
  aiPolicySchema,
  toPlatformUserId,
} from '@integr8/core';
import {
  AiPolicyVersionConflictError,
  getPlatformDataSource,
  TENANT_PLANS,
  type AiPlanPolicy,
  type AiTenantPolicy,
} from '@integr8/db';
import { z } from 'zod';
import {
  AI_MAX_LEVEL_SERVED,
  forgetAiPolicy,
  resolveEffectiveAiPolicy,
} from '../../../ai/policy.js';
import { periodKeysAt } from '../../../ai/periods.js';
import { approvedDataClasses, providerStatus } from '../../../ai/providers/index.js';
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
  quotaMode: z.enum(AI_QUOTA_MODES).nullable(),
  dailyLimit: z.number().int().nullable(),
  monthlyLimit: z.number().int().nullable(),
  perUserDailyLimit: z.number().int().nullable(),
  perUserMonthlyLimit: z.number().int().nullable(),
  unlimitedMessages: z.boolean(),
  monthlyCostCapMicrousd: z.number().int().nullable(),
  maxInputTokens: z.number().int(),
  maxOutputTokens: z.number().int(),
  maxToolSteps: z.number().int(),
  maxProviderCalls: z.number().int(),
  allowHistory: z.boolean(),
  retentionDays: z.number().int(),
});

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
  offReason: z.enum(['global_off', 'plan_off', 'custom_off', 'not_served']).nullable(),
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
    const policy = parsePolicy(body.policy);
    const platform = getPlatformDataSource().ai;
    const before = await platform.planPolicy(params.plan);
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
    const policy = body.mode === 'custom' ? parsePolicy(body.policy) : body.policy;
    const before = await platform.ai.tenantPolicy(tenant.id);
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
        providers: AI_PROVIDERS.map((id) => ({
          id,
          configured: providerStatus(id, config),
          approvedDataClasses: approvedDataClasses(id, config),
        })),
      },
    });
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
