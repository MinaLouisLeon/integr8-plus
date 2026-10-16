import {
  AI_POLICY_OFF,
  type AiAnswerSource,
  type AiChannel,
  type AiLevel,
  type AiPolicy,
  minAiLevel,
  type Principal,
} from '@integr8/core';
import { type AiPolicyFields, getPlatformDataSource, withTenant } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import { servableLevel } from './configuration.js';
import type { ClientApp } from '../http/routes.js';
import { planFor } from '../http/suspension.js';

/**
 * What a company is allowed of the assistant, resolved (docs/ai §4.3;
 * ADR-0001 D1).
 *
 * The order is the gate order: the kill switch, then the plan's policy, then
 * the company's override when it is `custom`, then what this build of the
 * code serves at all, then where answers come from, then the server's own
 * ceilings. A missing plan row is off — fail closed — rather than uncapped.
 *
 * Answers come from a model or from the help library (ADR-0002 D9–D12). A
 * policy can ask for the library; a server that cannot give a company model
 * answers gives it the library instead, at Help, rather than nothing.
 *
 * Cached per company for thirty seconds, as the suspension status and the
 * module flags are, and forgotten at once when the dashboard writes a policy.
 * Admission never reads the cache for counters: those are database rows under
 * locks, and this is only the rule they are checked against.
 */

/**
 * The highest level this build serves, whatever is configured.
 *
 * Raised phase by phase as each level's authorization and isolation tests
 * pass (docs/ai/IMPLEMENTATION_STATUS.md). A plan or company set above it is
 * capped here, so an operator cannot switch on code that has not shipped.
 */
export const AI_MAX_LEVEL_SERVED: AiLevel = 'agent';

const CACHE_TTL_MS = 30_000;

export interface EffectiveAiPolicy extends AiPolicy {
  /** Where the policy came from: the plan, or the company's own override. */
  source: 'plan' | 'custom';
  /**
   * Why the level is `off`, when it is. `null` when the assistant is on.
   * `provider_unconfigured` is kept for older clients; since D11 a server
   * that cannot answer with a model answers from the library instead.
   */
  offReason:
    'global_off' | 'plan_off' | 'custom_off' | 'not_served' | 'provider_unconfigured' | null;
  /** Where this company's answers actually come from now (D9–D12). */
  answersFrom: AiAnswerSource;
  /**
   * Why answers come from the library, when they do: the policy says so, the
   * server has no provider by choice, or its AI settings are incomplete.
   */
  libraryReason: 'policy' | 'no_provider' | 'provider_unconfigured' | null;
  /** The level before this build's cap, for the dashboard to show honestly. */
  configuredLevel: AiLevel;
  /** Whether the company's own records may go to the provider (L2, L3). */
  companyDataToProvider: boolean;
  /** The override's version, for the dashboard's compare-and-swap. */
  overrideVersion: number | null;
}

interface CachedPolicy {
  policy: EffectiveAiPolicy;
  readAt: number;
}

const cache = new Map<string, CachedPolicy>();

export function forgetAiPolicy(tenantId?: string): void {
  if (tenantId === undefined) {
    cache.clear();
  } else {
    cache.delete(tenantId);
  }
}

export async function resolveEffectiveAiPolicy(
  tenantId: string,
  config: ApiConfig,
  now = Date.now(),
): Promise<EffectiveAiPolicy> {
  const cached = cache.get(tenantId);
  if (cached !== undefined && now - cached.readAt < CACHE_TTL_MS) {
    return cached.policy;
  }
  const policy = await read(tenantId, config, now);
  cache.set(tenantId, { policy, readAt: now });
  return policy;
}

async function read(tenantId: string, config: ApiConfig, now: number): Promise<EffectiveAiPolicy> {
  const platform = getPlatformDataSource().ai;
  const plan = await planFor(tenantId, now);
  const planPolicy = await platform.planPolicy(plan);
  const override = await platform.tenantPolicy(tenantId);

  const source: 'plan' | 'custom' = override?.mode === 'custom' ? 'custom' : 'plan';
  const chosen: AiPolicyFields =
    source === 'custom' && override !== undefined ? override : (planPolicy ?? AI_POLICY_OFF);
  const configuredLevel = chosen.level;

  let offReason: EffectiveAiPolicy['offReason'] = null;
  let level = configuredLevel;
  let answersFrom: AiAnswerSource = chosen.answerSource;
  let libraryReason: EffectiveAiPolicy['libraryReason'] = null;
  if (!config.AI_ENABLED) {
    offReason = 'global_off';
    level = 'off';
  } else if (configuredLevel === 'off') {
    offReason = source === 'custom' ? 'custom_off' : 'plan_off';
  } else if (minAiLevel(configuredLevel, AI_MAX_LEVEL_SERVED) === 'off') {
    offReason = 'not_served';
    level = 'off';
  } else if (chosen.answerSource === 'library') {
    // The library serves Help only, and needs nothing from the server (D10).
    level = 'help';
    libraryReason = 'policy';
  } else {
    // Capped again by what the server can run: a level whose model is not set
    // gives way to the highest one below it that has one (ADR-0002 D2, D3).
    level = servableLevel(minAiLevel(configuredLevel, AI_MAX_LEVEL_SERVED), config);
    if (level === 'off') {
      // No model at all: answer from the library rather than not at all (D11).
      level = 'help';
      answersFrom = 'library';
      libraryReason = config.AI_PROVIDER === 'none' ? 'no_provider' : 'provider_unconfigured';
    }
  }

  return {
    ...clampToServer(chosen, config),
    level,
    source,
    offReason,
    answersFrom,
    libraryReason,
    configuredLevel,
    companyDataToProvider: override?.companyDataToProvider ?? false,
    overrideVersion: override?.version ?? null,
  };
}

/** The server's ceilings win over whatever an admin typed. */
export function clampToServer(policy: AiPolicyFields, config: ApiConfig): AiPolicy {
  return {
    level: policy.level,
    answerSource: policy.answerSource,
    quotaMode: policy.quotaMode,
    dailyLimit: policy.dailyLimit,
    monthlyLimit: policy.monthlyLimit,
    perUserDailyLimit: policy.perUserDailyLimit,
    perUserMonthlyLimit: policy.perUserMonthlyLimit,
    unlimitedMessages: policy.unlimitedMessages,
    monthlyCostCapMicrousd: policy.monthlyCostCapMicrousd,
    dailyTokenLimit: policy.dailyTokenLimit,
    monthlyTokenLimit: policy.monthlyTokenLimit,
    maxInputTokens: Math.min(policy.maxInputTokens, config.AI_MAX_INPUT_TOKENS),
    maxOutputTokens: Math.min(policy.maxOutputTokens, config.AI_MAX_OUTPUT_TOKENS),
    maxToolSteps: Math.min(policy.maxToolSteps, config.AI_MAX_TOOL_STEPS),
    maxProviderCalls: Math.min(policy.maxProviderCalls, config.AI_MAX_PROVIDER_CALLS),
    allowHistory: policy.allowHistory,
    retentionDays: policy.retentionDays,
  };
}

// ---------------------------------------------------------------------------
// The company's and the member's own switches
// ---------------------------------------------------------------------------

export function channelOf(clientApp: ClientApp): AiChannel {
  // An unknown client (a script, `api`) is held to the web's switch: the
  // strictest reading that still lets the web app's own callers through.
  return clientApp === 'desktop' ? 'desktop' : clientApp === 'mobile' ? 'mobile' : 'web';
}

export interface AiAccess {
  policy: EffectiveAiPolicy;
  /** The level this member may actually use, after every switch. */
  level: AiLevel;
  channel: AiChannel;
  channelEnabled: boolean;
  memberEnabled: boolean;
  /** The member's percentage of the company's allowance; null is none (ADR-0002 D6). */
  sharePercent: number | null;
  /** The member's monthly dollar cap, set by the platform; never shown to the company (D7). */
  memberCostCapMicrousd: number | null;
  /** The first gate that closed, for the capabilities screen to explain. */
  blockedBy: EffectiveAiPolicy['offReason'] | 'channel_off' | 'member_off' | 'no_share' | null;
}

/**
 * Everything between the company's grant and this member's screen: the
 * resolved policy, the company's switch for this app, and the member's own.
 * Each can only narrow; none can widen.
 */
export async function resolveAiAccess(input: {
  principal: Principal;
  clientApp: ClientApp;
  config: ApiConfig;
  now?: number;
}): Promise<AiAccess> {
  const policy = await resolveEffectiveAiPolicy(input.principal.tenantId, input.config, input.now);
  const channel = channelOf(input.clientApp);
  const { settings, member, limits } = await withTenant(input.principal.tenantId, async (tx) => ({
    settings: await tx.settings.get(),
    member: await tx.tenantUsers.findByUserId(input.principal.userId),
    limits: await tx.aiMemberLimits.find(input.principal.userId),
  }));
  const channelEnabled = {
    web: settings.aiWebEnabled,
    desktop: settings.aiDesktopEnabled,
    mobile: settings.aiMobileEnabled,
  }[channel];
  // Integr8 staff acting as the company hold no membership row; their seat
  // follows the company's switches, and having no share, has no model
  // answers.
  const memberEnabled = member?.aiEnabled ?? true;
  // For model answers a member needs a share of the company's allowance as
  // well as their switch: no share, no assistant (ADR-0002 D6). Library
  // answers cost nothing, so they need the switch only (D10).
  const sharePercent = limits?.sharePercent ?? null;
  const shareNeeded = policy.answersFrom === 'model';

  const blockedBy =
    policy.level === 'off'
      ? policy.offReason
      : !channelEnabled
        ? 'channel_off'
        : !memberEnabled
          ? 'member_off'
          : shareNeeded && sharePercent === null
            ? 'no_share'
            : null;

  return {
    policy,
    level: blockedBy === null ? policy.level : 'off',
    channel,
    channelEnabled,
    memberEnabled,
    sharePercent,
    memberCostCapMicrousd: limits?.monthlyCostCapMicrousd ?? null,
    blockedBy,
  };
}
