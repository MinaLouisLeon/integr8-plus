import { ApiRequestError } from '@integr8/api-client';
import { describe, expect, it } from 'vitest';
import {
  assistantLocale,
  exhaustedAxis,
  limitedAxes,
  quotaResetsAt,
  screenForAppRoute,
  type Usage,
  type UsageAxis,
} from './assistant';

const axis = (used: number, limit: number | null): UsageAxis => ({
  used,
  reserved: 0,
  limit,
  remaining: limit === null ? null : Math.max(0, limit - used),
  resetsAt: '2026-10-16T00:00:00.000Z',
});

const usage = (over: Partial<Usage> = {}): Usage => ({
  daily: axis(3, 50),
  monthly: null,
  user: { daily: axis(3, null), monthly: axis(3, null) },
  unlimited: false,
  ...over,
});

describe('limitedAxes', () => {
  it('lists only the axes the policy limits, company first', () => {
    expect(limitedAxes(usage()).map(({ scope, period }) => `${scope}.${period}`)).toEqual([
      'company.daily',
    ]);
    expect(
      limitedAxes(
        usage({ monthly: axis(10, 1000), user: { daily: axis(1, 10), monthly: axis(1, null) } }),
      ).map(({ scope, period }) => `${scope}.${period}`),
    ).toEqual(['company.daily', 'company.monthly', 'you.daily']);
    expect(limitedAxes(usage({ daily: null, unlimited: true }))).toEqual([]);
  });
});

describe('exhaustedAxis', () => {
  it('is the first axis with nothing left, and null while something is', () => {
    expect(exhaustedAxis(usage())).toBeNull();
    const spent = usage({ user: { daily: axis(10, 10), monthly: axis(10, null) } });
    expect(exhaustedAxis(spent)).toMatchObject({ scope: 'you', period: 'daily' });
    expect(exhaustedAxis(usage({ daily: axis(50, 50) }))).toMatchObject({
      scope: 'company',
      period: 'daily',
    });
  });
});

describe('screenForAppRoute', () => {
  it('maps the office’s route keys to the screens the phone has', () => {
    expect(screenForAppRoute('workOrders')).toBe('/home');
    expect(screenForAppRoute('myExpenses')).toBe('/expenses');
    expect(screenForAppRoute('payRuns')).toBe('/payslips');
    expect(screenForAppRoute('purchaseOrders')).toBe('/receive');
    expect(screenForAppRoute('stockLocations')).toBe('/van');
    expect(screenForAppRoute('assets')).toBe('/assets/scan');
  });

  it('is null for a key the phone has no screen for', () => {
    for (const key of [null, '', 'ledger', 'invoices', 'toString', 'constructor']) {
      expect(screenForAppRoute(key), String(key)).toBeNull();
    }
  });
});

describe('quotaResetsAt', () => {
  it('reads the reset instant from a used-up quota and nothing else', () => {
    const when = '2026-10-16T00:00:00.000Z';
    const quota = new ApiRequestError(429, 'ai_daily_quota_exceeded', 'Used up.', 'req', [
      {
        field: 'message',
        code: 'ai_daily_quota_exceeded',
        message: '',
        params: { resetsAt: when },
      },
    ]);
    expect(quotaResetsAt(quota)).toBe(when);
    expect(quotaResetsAt(new ApiRequestError(429, 'ai_concurrency_limit', '', 'req'))).toBeNull();
    expect(quotaResetsAt(new ApiRequestError(403, 'ai_disabled', '', 'req'))).toBeNull();
    expect(
      quotaResetsAt(
        new ApiRequestError(429, 'x', '', 'req', [
          { field: 'f', code: 'x', message: '', params: { resetsAt: 'soon' } },
        ]),
      ),
    ).toBeNull();
    expect(quotaResetsAt(new TypeError('Network request failed'))).toBeNull();
  });
});

describe('assistantLocale', () => {
  it('is Arabic for any Arabic tag and English for the rest', () => {
    expect(assistantLocale('ar')).toBe('ar');
    expect(assistantLocale('ar-EG')).toBe('ar');
    expect(assistantLocale('en')).toBe('en');
    expect(assistantLocale('en-GB')).toBe('en');
    expect(assistantLocale('fr')).toBe('en');
  });
});
