import {
  type AiPolicy,
  aiPeriodOf,
  type AiPeriodType,
  quotaModeHasDaily,
  quotaModeHasMonthly,
} from '@integr8/core';
import type { AiPeriodKeys, AiTokenLimits, AiUsageCounter } from '@integr8/db';

/**
 * The UTC periods a request falls in, the limits it is held to, and what the
 * screens are shown (docs/ai §2.3; ADR-0001 D2; ADR-0002 D5–D7).
 *
 * The platform sees numbers. A company and its staff see percentages: how
 * much of the allowance is left, never the tokens, messages or dollars behind
 * it (ADR-0002 D7).
 */

export function periodKeysAt(now: Date): AiPeriodKeys {
  return { day: aiPeriodOf('day', now).start, month: aiPeriodOf('month', now).start };
}

/** One axis as the platform sees it: what is used, held, allowed and left, and when it resets. */
export interface AiUsageAxis {
  used: number;
  reserved: number;
  /** Null when this axis is not limited. */
  limit: number | null;
  /** Null when there is no limit to be short of. */
  remaining: number | null;
  resetsAt: string;
}

/**
 * A member's slice of a company limit: the share, in whole percent, of it,
 * rounded down. A company axis with no limit gives the member none either; a
 * member with no share gets nothing, though access is refused before this.
 */
export function shareOf(limit: number | null, sharePercent: number | null): number | null {
  if (limit === null) {
    return null;
  }
  if (sharePercent === null) {
    return 0;
  }
  return Math.floor((limit * sharePercent) / 100);
}

/**
 * The message limits admission checks: the company's from the policy, the
 * member's as their share of the company's (ADR-0002 D6). The plan's shared
 * per-member default no longer decides anything. Null on an axis means not
 * limited.
 */
export function limitsOf(policy: AiPolicy, sharePercent: number | null): AiTokenLimits {
  const tenantDaily =
    !policy.unlimitedMessages && quotaModeHasDaily(policy.quotaMode) ? policy.dailyLimit : null;
  const tenantMonthly =
    !policy.unlimitedMessages && quotaModeHasMonthly(policy.quotaMode) ? policy.monthlyLimit : null;
  return {
    tenantDaily,
    tenantMonthly,
    userDaily: shareOf(tenantDaily, sharePercent),
    userMonthly: shareOf(tenantMonthly, sharePercent),
  };
}

/** The token limits each model call is held against (ADR-0002 D5, D6). */
export function tokenLimitsOf(policy: AiPolicy, sharePercent: number | null): AiTokenLimits {
  return {
    tenantDaily: policy.dailyTokenLimit,
    tenantMonthly: policy.monthlyTokenLimit,
    userDaily: shareOf(policy.dailyTokenLimit, sharePercent),
    userMonthly: shareOf(policy.monthlyTokenLimit, sharePercent),
  };
}

/**
 * What a company or a member is shown: how much of the allowance is left, as
 * a whole percentage of the tightest limited axis, and when that axis resets.
 * Null when nothing is limited. `exhausted` means a question would be refused
 * now.
 */
export interface AiAllowance {
  remainingPercent: number | null;
  resetsAt: string | null;
  exhausted: boolean;
}

interface Axis {
  limit: number | null;
  used: number;
  reserved: number;
  period: AiPeriodType;
}

export function allowanceOf(axes: Axis[], now: Date): AiAllowance {
  const limited = axes.filter(
    (axis): axis is Axis & { limit: number } => axis.limit !== null && axis.limit >= 0,
  );
  if (limited.length === 0) {
    return { remainingPercent: null, resetsAt: null, exhausted: false };
  }
  let tightest: { percent: number; period: AiPeriodType; remaining: number } | null = null;
  for (const axis of limited) {
    const remaining = Math.max(0, axis.limit - axis.used - axis.reserved);
    const percent = axis.limit === 0 ? 0 : Math.floor((remaining * 100) / axis.limit);
    if (
      tightest === null ||
      percent < tightest.percent ||
      (percent === tightest.percent && axis.period === 'day')
    ) {
      tightest = { percent, period: axis.period, remaining };
    }
  }
  // `limited` is not empty, so neither is `tightest`.
  const chosen = tightest ?? { percent: 0, period: 'day' as const, remaining: 0 };
  return {
    remainingPercent: chosen.percent,
    resetsAt: aiPeriodOf(chosen.period, now).resetsAt.toISOString(),
    exhausted: chosen.remaining === 0,
  };
}

function counterOf(
  counters: AiUsageCounter[],
  subject: 'tenant' | 'user',
  period: AiPeriodType,
): { used: number; reserved: number } {
  const row = counters.find((counter) => counter.subject === subject && counter.period === period);
  return { used: row?.used ?? 0, reserved: row?.reserved ?? 0 };
}

/** The member's own allowance left: their share of messages and tokens, day and month. */
export function memberAllowance(input: {
  policy: AiPolicy;
  sharePercent: number | null;
  messages: AiUsageCounter[];
  tokens: AiUsageCounter[];
  now: Date;
}): AiAllowance {
  const messageLimits = limitsOf(input.policy, input.sharePercent);
  const tokenLimits = tokenLimitsOf(input.policy, input.sharePercent);
  return allowanceOf(
    [
      {
        limit: messageLimits.userDaily,
        ...counterOf(input.messages, 'user', 'day'),
        period: 'day',
      },
      {
        limit: messageLimits.userMonthly,
        ...counterOf(input.messages, 'user', 'month'),
        period: 'month',
      },
      { limit: tokenLimits.userDaily, ...counterOf(input.tokens, 'user', 'day'), period: 'day' },
      {
        limit: tokenLimits.userMonthly,
        ...counterOf(input.tokens, 'user', 'month'),
        period: 'month',
      },
    ],
    input.now,
  );
}

/** The company's whole allowance left: its pooled messages and tokens, day and month. */
export function companyAllowance(input: {
  policy: AiPolicy;
  messages: AiUsageCounter[];
  tokens: AiUsageCounter[];
  now: Date;
}): AiAllowance {
  const messageLimits = limitsOf(input.policy, null);
  return allowanceOf(
    [
      {
        limit: messageLimits.tenantDaily,
        ...counterOf(input.messages, 'tenant', 'day'),
        period: 'day',
      },
      {
        limit: messageLimits.tenantMonthly,
        ...counterOf(input.messages, 'tenant', 'month'),
        period: 'month',
      },
      {
        limit: input.policy.dailyTokenLimit,
        ...counterOf(input.tokens, 'tenant', 'day'),
        period: 'day',
      },
      {
        limit: input.policy.monthlyTokenLimit,
        ...counterOf(input.tokens, 'tenant', 'month'),
        period: 'month',
      },
    ],
    input.now,
  );
}
