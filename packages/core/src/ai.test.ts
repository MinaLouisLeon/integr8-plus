import { describe, expect, it } from 'vitest';
import {
  AI_POLICY_OFF,
  aiLevelAtLeast,
  aiPeriodOf,
  aiPolicySchema,
  minAiLevel,
  nextUtcDay,
  nextUtcMonth,
  utcDayStart,
  utcMonthStart,
} from './ai.js';

/**
 * The assistant's periods and policy shape (ADR-0001). The periods are UTC
 * calendar days and months whatever the company's timezone, and the boundary
 * cases — the last second of a day, a leap day, December — are the ones a
 * counter keyed on the wrong instant would get wrong.
 */

describe('UTC periods', () => {
  it('keys a day by its UTC date, right up to the last second', () => {
    expect(utcDayStart(new Date('2026-10-15T23:59:59.999Z'))).toBe('2026-10-15');
    expect(utcDayStart(new Date('2026-10-16T00:00:00.000Z'))).toBe('2026-10-16');
    expect(nextUtcDay(new Date('2026-10-15T23:59:59.999Z')).toISOString()).toBe(
      '2026-10-16T00:00:00.000Z',
    );
  });

  it('keys a month by its first day and resets on the first of the next', () => {
    expect(utcMonthStart(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10-01');
    expect(nextUtcMonth(new Date('2026-12-31T12:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('handles a leap day as a day of February', () => {
    expect(utcDayStart(new Date('2028-02-29T10:00:00Z'))).toBe('2028-02-29');
    expect(nextUtcDay(new Date('2028-02-29T10:00:00Z')).toISOString()).toBe(
      '2028-03-01T00:00:00.000Z',
    );
    expect(aiPeriodOf('month', new Date('2028-02-29T10:00:00Z'))).toEqual({
      start: '2028-02-01',
      resetsAt: new Date('2028-03-01T00:00:00.000Z'),
    });
  });
});

describe('levels', () => {
  it('are cumulative and cap downwards', () => {
    expect(aiLevelAtLeast('agent', 'help')).toBe(true);
    expect(aiLevelAtLeast('help', 'insights')).toBe(false);
    expect(aiLevelAtLeast('off', 'off')).toBe(true);
    expect(minAiLevel('agent', 'help')).toBe('help');
    expect(minAiLevel('off', 'agent')).toBe('off');
  });
});

describe('a policy', () => {
  it('is off with nothing else, as every plan starts', () => {
    expect(aiPolicySchema.safeParse(AI_POLICY_OFF).success).toBe(true);
  });

  it('needs the limits its quota mode names', () => {
    const base = { ...AI_POLICY_OFF, level: 'help' as const };
    expect(aiPolicySchema.safeParse(base).success).toBe(false);
    expect(
      aiPolicySchema.safeParse({ ...base, quotaMode: 'daily', dailyLimit: null }).success,
    ).toBe(false);
    expect(aiPolicySchema.safeParse({ ...base, quotaMode: 'daily', dailyLimit: 10 }).success).toBe(
      true,
    );
    expect(
      aiPolicySchema.safeParse({ ...base, quotaMode: 'daily_and_monthly', dailyLimit: 10 }).success,
    ).toBe(false);
    expect(
      aiPolicySchema.safeParse({
        ...base,
        quotaMode: 'daily_and_monthly',
        dailyLimit: 10,
        monthlyLimit: 100,
      }).success,
    ).toBe(true);
  });

  it('allows unlimited messages only under a cost ceiling and without a mode', () => {
    const base = { ...AI_POLICY_OFF, level: 'help' as const, unlimitedMessages: true };
    expect(aiPolicySchema.safeParse(base).success).toBe(false);
    expect(aiPolicySchema.safeParse({ ...base, monthlyCostCapMicrousd: 5_000_000 }).success).toBe(
      true,
    );
    expect(
      aiPolicySchema.safeParse({ ...base, monthlyCostCapMicrousd: 5_000_000, quotaMode: 'daily' })
        .success,
    ).toBe(false);
  });

  it('refuses zero and negative limits', () => {
    expect(
      aiPolicySchema.safeParse({
        ...AI_POLICY_OFF,
        level: 'help',
        quotaMode: 'daily',
        dailyLimit: 0,
      }).success,
    ).toBe(false);
    expect(aiPolicySchema.safeParse({ ...AI_POLICY_OFF, maxOutputTokens: -1 }).success).toBe(false);
  });
});
