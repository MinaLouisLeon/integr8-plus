import { ApiRequestError } from '@integr8/api-client';
import { describe, expect, it } from 'vitest';
import {
  parseShareInput,
  shareRefusal,
  shareText,
  summariseAllowance,
  unassignedPercent,
} from './ai-shares';

describe('parseShareInput', () => {
  it('reads empty as no share', () => {
    expect(parseShareInput('')).toEqual({ ok: true, sharePercent: null });
    expect(parseShareInput('   ')).toEqual({ ok: true, sharePercent: null });
  });

  it('reads a whole number from 1 to 100, with or without a percent sign', () => {
    expect(parseShareInput('1')).toEqual({ ok: true, sharePercent: 1 });
    expect(parseShareInput(' 30 ')).toEqual({ ok: true, sharePercent: 30 });
    expect(parseShareInput('100%')).toEqual({ ok: true, sharePercent: 100 });
    expect(parseShareInput('٢٥')).toEqual({ ok: true, sharePercent: 25 });
    expect(parseShareInput('٢٥٪')).toEqual({ ok: true, sharePercent: 25 });
  });

  it('refuses anything the server would', () => {
    for (const text of ['0', '101', '12.5', '-5', 'ten', '1e2', '1000']) {
      expect(parseShareInput(text), text).toEqual({ ok: false });
    }
  });
});

describe('shareText', () => {
  it('shows a share as its number and no share as an empty box', () => {
    expect(shareText(40)).toBe('40');
    expect(shareText(null)).toBe('');
  });
});

describe('unassignedPercent', () => {
  it('is what is left of 100, never below none', () => {
    expect(unassignedPercent(70)).toBe(30);
    expect(unassignedPercent(0)).toBe(100);
    expect(unassignedPercent(100)).toBe(0);
    expect(unassignedPercent(120)).toBe(0);
  });
});

describe('shareRefusal', () => {
  it('reads a save somebody else beat', () => {
    expect(shareRefusal(new ApiRequestError(409, 'ai_member_limits_changed', '', 'req'))).toEqual({
      kind: 'changed',
    });
  });

  it('reads shares over 100%, with what is still unassigned', () => {
    const over = (availablePercent?: string) =>
      new ApiRequestError(422, 'ai_shares_over_total', '', 'req', [
        {
          field: 'body.sharePercent',
          code: 'ai_shares_over_total',
          message: '',
          ...(availablePercent === undefined ? {} : { params: { availablePercent } }),
        },
      ]);
    expect(shareRefusal(over('30'))).toEqual({ kind: 'overTotal', availablePercent: 30 });
    expect(shareRefusal(over('0'))).toEqual({ kind: 'overTotal', availablePercent: 0 });
    expect(shareRefusal(over())).toEqual({ kind: 'overTotal', availablePercent: null });
    expect(shareRefusal(over('lots'))).toEqual({ kind: 'overTotal', availablePercent: null });
  });

  it('reads a member who outranks the caller', () => {
    expect(shareRefusal(new ApiRequestError(403, 'forbidden', '', 'req'))).toEqual({
      kind: 'outranked',
    });
  });

  it('is null for anything else', () => {
    expect(shareRefusal(new ApiRequestError(422, 'validation_failed', '', 'req'))).toBeNull();
    expect(shareRefusal(new ApiRequestError(500, 'internal_error', '', 'req'))).toBeNull();
    expect(shareRefusal(new TypeError('Failed to fetch'))).toBeNull();
  });
});

describe('summariseAllowance', () => {
  const resetsAt = '2026-10-16T00:00:00.000Z';

  it('is the percentage left and when it resets', () => {
    expect(summariseAllowance({ remainingPercent: 45, resetsAt, exhausted: false })).toEqual({
      kind: 'remaining',
      percent: 45,
      resetsAt,
    });
  });

  it('is used up whenever the server says so', () => {
    expect(summariseAllowance({ remainingPercent: 20, resetsAt, exhausted: true })).toEqual({
      kind: 'usedUp',
      resetsAt,
    });
  });

  it('is unlimited when nothing is limited', () => {
    expect(
      summariseAllowance({ remainingPercent: null, resetsAt: null, exhausted: false }),
    ).toEqual({ kind: 'unlimited' });
  });

  it('keeps the percentage within 0–100 and drops a reset it cannot read', () => {
    expect(
      summariseAllowance({ remainingPercent: 130, resetsAt: 'later', exhausted: false }),
    ).toEqual({ kind: 'remaining', percent: 100, resetsAt: null });
  });
});
