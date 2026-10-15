import { ApiRequestError } from '@integr8/api-client';
import { describe, expect, it } from 'vitest';
import {
  type Allowance,
  allowanceLine,
  assistantLocale,
  quotaResetsAt,
  screenForAppRoute,
  sendBlock,
} from './assistant';

const RESET = '2026-10-16T00:00:00.000Z';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');

const allowance = (over: Partial<Allowance> = {}): Allowance => ({
  remainingPercent: 62,
  resetsAt: RESET,
  exhausted: false,
  ...over,
});

describe('allowanceLine', () => {
  it('says what is left and when it resets', () => {
    expect(allowanceLine(allowance())).toEqual({ kind: 'remaining', percent: 62, resetsAt: RESET });
    expect(allowanceLine(allowance({ resetsAt: null }))).toEqual({
      kind: 'remaining',
      percent: 62,
      resetsAt: null,
    });
  });

  it('says nothing when nothing is limited', () => {
    expect(allowanceLine(allowance({ remainingPercent: null, resetsAt: null }))).toBeNull();
  });

  it('is used up whenever the server says so, whatever percentage is left', () => {
    expect(allowanceLine(allowance({ remainingPercent: 0, exhausted: true }))).toEqual({
      kind: 'usedUp',
      resetsAt: RESET,
    });
    // The company's pool can be spent while the member's own slice is not.
    expect(allowanceLine(allowance({ remainingPercent: 40, exhausted: true }))).toEqual({
      kind: 'usedUp',
      resetsAt: RESET,
    });
    expect(allowanceLine(allowance({ remainingPercent: null, exhausted: true }))).toEqual({
      kind: 'usedUp',
      resetsAt: RESET,
    });
  });

  it('keeps the percentage whole and between 0 and 100, and drops a reset it cannot read', () => {
    expect(allowanceLine(allowance({ remainingPercent: 140 }))).toMatchObject({ percent: 100 });
    expect(allowanceLine(allowance({ remainingPercent: -3 }))).toMatchObject({ percent: 0 });
    expect(allowanceLine(allowance({ resetsAt: 'soon' }))).toMatchObject({ resetsAt: null });
  });
});

describe('sendBlock', () => {
  it('is open while some allowance is left and nothing was refused', () => {
    expect(sendBlock(allowance(), null, NOW)).toBeNull();
    expect(sendBlock(allowance({ remainingPercent: null }), null, NOW)).toBeNull();
  });

  it('is closed until the reset while the allowance is used up', () => {
    expect(sendBlock(allowance({ exhausted: true }), null, NOW)).toEqual({ resetsAt: RESET });
    expect(sendBlock(allowance({ exhausted: true, resetsAt: null }), null, NOW)).toEqual({
      resetsAt: null,
    });
  });

  it('opens again once a used-up allowance’s reset has passed', () => {
    expect(sendBlock(allowance({ exhausted: true }), null, Date.parse(RESET) + 1)).toBeNull();
  });

  it('is closed until a refusal’s reset, and open after it', () => {
    expect(sendBlock(allowance(), RESET, NOW)).toEqual({ resetsAt: RESET });
    expect(sendBlock(allowance(), RESET, Date.parse(RESET))).toBeNull();
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
  const refusal = (code: string, params?: Record<string, string>) =>
    new ApiRequestError(429, code, 'Used up.', 'req', [
      { field: 'message', code, message: '', ...(params === undefined ? {} : { params }) },
    ]);

  it('reads the reset instant from every used-up quota', () => {
    for (const code of [
      'ai_daily_quota_exceeded',
      'ai_monthly_quota_exceeded',
      'ai_daily_token_quota_exceeded',
      'ai_monthly_token_quota_exceeded',
      'ai_member_budget_exceeded',
    ]) {
      expect(quotaResetsAt(refusal(code, { resetsAt: RESET })), code).toBe(RESET);
    }
  });

  it('is null for anything else', () => {
    expect(quotaResetsAt(new ApiRequestError(429, 'ai_concurrency_limit', '', 'req'))).toBeNull();
    expect(quotaResetsAt(refusal('ai_daily_token_quota_exceeded'))).toBeNull();
    expect(quotaResetsAt(new ApiRequestError(403, 'ai_disabled', '', 'req'))).toBeNull();
    expect(quotaResetsAt(refusal('x', { resetsAt: 'soon' }))).toBeNull();
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
