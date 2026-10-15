import { z } from 'zod';

/**
 * The assistant's vocabulary, shared by every client and the API (docs/ai;
 * ADR-0001).
 *
 * Levels, quota modes and policy shapes are data here and check constraints in
 * the database (migration 0044), so a screen can never offer a value the server
 * refuses, and the server can never store one a screen cannot show.
 */

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** Off, then three cumulative levels: help, company insights, agent actions. */
export const AI_LEVELS = ['off', 'help', 'insights', 'agent'] as const;
export const aiLevelSchema = z.enum(AI_LEVELS);
export type AiLevel = z.infer<typeof aiLevelSchema>;

const LEVEL_RANK: Readonly<Record<AiLevel, number>> = Object.freeze({
  off: 0,
  help: 1,
  insights: 2,
  agent: 3,
});

/** True when `level` includes everything `required` does. */
export function aiLevelAtLeast(level: AiLevel, required: AiLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[required];
}

/** The lower of two levels: what a cap does to a grant. */
export function minAiLevel(a: AiLevel, b: AiLevel): AiLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

export const AI_QUOTA_MODES = ['daily', 'monthly', 'daily_and_monthly'] as const;
export const aiQuotaModeSchema = z.enum(AI_QUOTA_MODES);
export type AiQuotaMode = z.infer<typeof aiQuotaModeSchema>;

export const AI_POLICY_MODES = ['inherit', 'custom'] as const;
export const aiPolicyModeSchema = z.enum(AI_POLICY_MODES);
export type AiPolicyMode = z.infer<typeof aiPolicyModeSchema>;

/** Which of a company's apps the assistant may appear in. Each is a switch the company owns. */
export const AI_CHANNELS = ['web', 'desktop', 'mobile'] as const;
export const aiChannelSchema = z.enum(AI_CHANNELS);
export type AiChannel = z.infer<typeof aiChannelSchema>;

/** What a tool's result is made of, and therefore which providers may see it. */
export const AI_DATA_CLASSES = [
  'public_help',
  'company_operational',
  'company_financial',
  'restricted_personal',
] as const;
export const aiDataClassSchema = z.enum(AI_DATA_CLASSES);
export type AiDataClass = z.infer<typeof aiDataClassSchema>;

export const AI_PROVIDERS = ['recording', 'groq', 'gemini', 'anthropic'] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProviderId = z.infer<typeof aiProviderSchema>;

const positiveInt = z.number().int().positive();
/** Integer USD micros, within what a JavaScript number represents exactly. */
export const microusdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * One policy: what a plan or a company allows.
 *
 * Every field is explicit. Null on a limit means "this axis is not
 * configured", never "unlimited": a level above off needs a quota mode with
 * the limits that mode names, or the explicit `unlimitedMessages` with a cost
 * ceiling. The refinement below says the same thing the database's check
 * constraint says, so a bad policy is a 422 that names the field rather than a
 * 500 from Postgres.
 */
export const aiPolicySchema = z
  .object({
    level: aiLevelSchema,
    quotaMode: aiQuotaModeSchema.nullable(),
    dailyLimit: positiveInt.nullable(),
    monthlyLimit: positiveInt.nullable(),
    perUserDailyLimit: positiveInt.nullable(),
    perUserMonthlyLimit: positiveInt.nullable(),
    unlimitedMessages: z.boolean(),
    monthlyCostCapMicrousd: microusdSchema.positive().nullable(),
    maxInputTokens: positiveInt,
    maxOutputTokens: positiveInt,
    maxToolSteps: positiveInt,
    maxProviderCalls: positiveInt,
    allowHistory: z.boolean(),
    retentionDays: positiveInt.max(3650),
  })
  .superRefine((policy, context) => {
    if (policy.level === 'off') {
      return;
    }
    if (policy.unlimitedMessages) {
      if (policy.quotaMode !== null) {
        context.addIssue({
          code: 'custom',
          path: ['quotaMode'],
          message: 'Unlimited messages has no quota mode.',
        });
      }
      if (policy.monthlyCostCapMicrousd === null) {
        context.addIssue({
          code: 'custom',
          path: ['monthlyCostCapMicrousd'],
          message: 'Unlimited messages needs a monthly cost ceiling.',
        });
      }
      return;
    }
    if (policy.quotaMode === null) {
      context.addIssue({
        code: 'custom',
        path: ['quotaMode'],
        message: 'An enabled level needs a quota mode.',
      });
      return;
    }
    if (quotaModeHasDaily(policy.quotaMode) && policy.dailyLimit === null) {
      context.addIssue({
        code: 'custom',
        path: ['dailyLimit'],
        message: 'A daily quota needs a daily limit.',
      });
    }
    if (quotaModeHasMonthly(policy.quotaMode) && policy.monthlyLimit === null) {
      context.addIssue({
        code: 'custom',
        path: ['monthlyLimit'],
        message: 'A monthly quota needs a monthly limit.',
      });
    }
  });

export type AiPolicy = z.infer<typeof aiPolicySchema>;

export function quotaModeHasDaily(mode: AiQuotaMode | null): boolean {
  return mode === 'daily' || mode === 'daily_and_monthly';
}

export function quotaModeHasMonthly(mode: AiQuotaMode | null): boolean {
  return mode === 'monthly' || mode === 'daily_and_monthly';
}

/** The policy every plan starts with, and what "Reset" means: nothing, until an admin decides. */
export const AI_POLICY_OFF: AiPolicy = Object.freeze({
  level: 'off',
  quotaMode: null,
  dailyLimit: null,
  monthlyLimit: null,
  perUserDailyLimit: null,
  perUserMonthlyLimit: null,
  unlimitedMessages: false,
  monthlyCostCapMicrousd: null,
  maxInputTokens: 4000,
  maxOutputTokens: 600,
  maxToolSteps: 1,
  maxProviderCalls: 1,
  allowHistory: true,
  retentionDays: 30,
});

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export const AI_PERIOD_TYPES = ['day', 'month'] as const;
export type AiPeriodType = (typeof AI_PERIOD_TYPES)[number];

/** `YYYY-MM-DD` of the UTC day `at` falls in. */
export function utcDayStart(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `YYYY-MM-01` of the UTC month `at` falls in. */
export function utcMonthStart(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`;
}

/** The first instant of the next UTC day after `at`. */
export function nextUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
}

/** The first instant of the next UTC month after `at`. */
export function nextUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** The counter key and reset instant of the period `at` falls in. */
export function aiPeriodOf(type: AiPeriodType, at: Date): { start: string; resetsAt: Date } {
  return type === 'day'
    ? { start: utcDayStart(at), resetsAt: nextUtcDay(at) }
    : { start: utcMonthStart(at), resetsAt: nextUtcMonth(at) };
}

// ---------------------------------------------------------------------------
// Conversations and actions
// ---------------------------------------------------------------------------

export const AI_MESSAGE_ROLES = ['user', 'assistant', 'tool_summary'] as const;
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];

export const AI_RESERVATION_STATES = [
  'reserved',
  'completed',
  'released',
  'expired',
  'uncertain',
] as const;
export type AiReservationState = (typeof AI_RESERVATION_STATES)[number];

export const AI_PROPOSAL_STATES = [
  'pending',
  'confirmed',
  'executing',
  'completed',
  'rejected',
  'expired',
  'failed',
] as const;
export type AiProposalState = (typeof AI_PROPOSAL_STATES)[number];

export const AI_CALL_PURPOSES = ['help', 'insights', 'agent', 'other'] as const;
export type AiCallPurpose = (typeof AI_CALL_PURPOSES)[number];

export const AI_CALL_STATUSES = ['success', 'failed', 'timeout', 'unknown'] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

/** A citation the assistant hands back: always an article it actually retrieved. */
export const aiSourceRefSchema = z.object({
  kind: z.literal('help'),
  articleKey: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  /** The app's route key the article is about, for a client to map to its own screen. */
  appRoute: z.string().max(64).nullable(),
  helpUrl: z.string().max(2048).nullable(),
});
export type AiSourceRef = z.infer<typeof aiSourceRefSchema>;

/** What a tool did, as shown to the person: the tool's key and a short result. */
export const aiToolSummarySchema = z.object({
  tool: z.string().min(1).max(64),
  result: z.string().max(2000),
});
export type AiToolSummary = z.infer<typeof aiToolSummarySchema>;
