import { type AiPolicy, aiPeriodOf, quotaModeHasDaily, quotaModeHasMonthly } from '@integr8/core';
import type { AiPeriodKeys, AiUsageCounter } from '@integr8/db';

/**
 * The UTC periods a request falls in, and the usage figures a screen shows
 * (docs/ai §2.3; ADR-0001 D2).
 */

export function periodKeysAt(now: Date): AiPeriodKeys {
  return { day: aiPeriodOf('day', now).start, month: aiPeriodOf('month', now).start };
}

/** One axis as the client sees it: what is used, held, allowed and left, and when it resets. */
export interface AiUsageAxis {
  used: number;
  reserved: number;
  /** Null when this axis is not limited. */
  limit: number | null;
  /** Null when there is no limit to be short of. */
  remaining: number | null;
  resetsAt: string;
}

export interface AiUsageView {
  /** The company's pooled counters. Null when the axis is not configured. */
  daily: AiUsageAxis | null;
  monthly: AiUsageAxis | null;
  /** This member's own counters, always shown; limited only when the policy says so. */
  user: { daily: AiUsageAxis; monthly: AiUsageAxis };
  unlimited: boolean;
}

/**
 * The limits admission checks, from the policy: null on an axis means not
 * limited. Per-member limits never widen the company's.
 */
export function limitsOf(policy: AiPolicy): {
  tenantDaily: number | null;
  tenantMonthly: number | null;
  userDaily: number | null;
  userMonthly: number | null;
} {
  if (policy.unlimitedMessages) {
    return {
      tenantDaily: null,
      tenantMonthly: null,
      userDaily: policy.perUserDailyLimit,
      userMonthly: policy.perUserMonthlyLimit,
    };
  }
  return {
    tenantDaily: quotaModeHasDaily(policy.quotaMode) ? policy.dailyLimit : null,
    tenantMonthly: quotaModeHasMonthly(policy.quotaMode) ? policy.monthlyLimit : null,
    userDaily: policy.perUserDailyLimit,
    userMonthly: policy.perUserMonthlyLimit,
  };
}

export function usageView(policy: AiPolicy, counters: AiUsageCounter[], now: Date): AiUsageView {
  const limits = limitsOf(policy);
  const axis = (
    subject: 'tenant' | 'user',
    period: 'day' | 'month',
    limit: number | null,
  ): AiUsageAxis => {
    const counter = counters.find((row) => row.subject === subject && row.period === period);
    const used = counter?.used ?? 0;
    const reserved = counter?.reserved ?? 0;
    return {
      used,
      reserved,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used - reserved),
      resetsAt: aiPeriodOf(period, now).resetsAt.toISOString(),
    };
  };
  return {
    daily: limits.tenantDaily === null ? null : axis('tenant', 'day', limits.tenantDaily),
    monthly: limits.tenantMonthly === null ? null : axis('tenant', 'month', limits.tenantMonthly),
    user: {
      daily: axis('user', 'day', limits.userDaily),
      monthly: axis('user', 'month', limits.userMonthly),
    },
    unlimited: policy.unlimitedMessages,
  };
}
