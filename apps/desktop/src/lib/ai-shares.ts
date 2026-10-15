import { ApiRequestError } from '@integr8/api-client';

/**
 * Members' shares of the company's assistant allowance, read and written as
 * the desktop's assistant settings screen needs them (docs/ai/ADR-0002 D6, D7).
 *
 * Pure, so the rules a person can trip over — what the box accepts, and what
 * each refusal means — are tested without a window.
 */

/** What a share box holds once read: a share, no share, or something the server would refuse. */
export type ShareInput = { ok: true; sharePercent: number | null } | { ok: false };

/**
 * A share as typed: empty is no share (and so no assistant); otherwise a whole
 * number from 1 to 100. Western and Arabic-Indic digits both count, since an
 * Arabic keyboard types the latter and the number means the same.
 */
export function parseShareInput(text: string): ShareInput {
  const trimmed = text
    .trim()
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[%٪]$/u, '')
    .trim();
  if (trimmed === '') {
    return { ok: true, sharePercent: null };
  }
  if (!/^\d{1,3}$/u.test(trimmed)) {
    return { ok: false };
  }
  const value = Number(trimmed);
  return value >= 1 && value <= 100 ? { ok: true, sharePercent: value } : { ok: false };
}

/** What a saved share shows in its box: the number, or nothing for no share. */
export function shareText(sharePercent: number | null): string {
  return sharePercent === null ? '' : String(sharePercent);
}

/** The part of the company's allowance nobody holds yet. */
export function unassignedPercent(assignedPercent: number): number {
  return Math.max(0, 100 - assignedPercent);
}

/** A refused save, by what the person can do about it; null for any other failure. */
export type ShareRefusal =
  | { kind: 'changed' }
  | { kind: 'overTotal'; availablePercent: number | null }
  | { kind: 'outranked' };

/**
 * Reads the refusals `PUT /v1/ai/shares/:userId` gives for a reason the
 * person can act on: somebody saved first (409), the shares would pass 100%
 * (422, with what is still unassigned), or the member's role is above the
 * caller's (403).
 */
export function shareRefusal(error: unknown): ShareRefusal | null {
  if (!(error instanceof ApiRequestError)) {
    return null;
  }
  if (error.status === 409 && error.code === 'ai_member_limits_changed') {
    return { kind: 'changed' };
  }
  if (error.status === 422 && error.code === 'ai_shares_over_total') {
    const raw = error.details.find((detail) => detail.code === 'ai_shares_over_total')?.params
      ?.availablePercent;
    const available = raw === undefined ? Number.NaN : Number(raw);
    return {
      kind: 'overTotal',
      availablePercent: Number.isInteger(available) && available >= 0 ? available : null,
    };
  }
  if (error.status === 403) {
    return { kind: 'outranked' };
  }
  return null;
}

/** What is left of an allowance, as the server reports it: percentages and a reset time only. */
export interface Allowance {
  /** 0–100; null when nothing is limited. */
  remainingPercent: number | null;
  resetsAt: string | null;
  /** True when a question would be refused now. */
  exhausted: boolean;
}

export type AllowanceSummary =
  | { kind: 'remaining'; percent: number; resetsAt: string | null }
  | { kind: 'usedUp'; resetsAt: string | null }
  | { kind: 'unlimited' };

/**
 * An allowance as one line. Used up wins over a percentage: the server
 * decides it from every limit it checks, so a member's slice can show some
 * left while the company's pool is spent.
 */
export function summariseAllowance(allowance: Allowance): AllowanceSummary {
  const resetsAt =
    allowance.resetsAt === null || Number.isNaN(Date.parse(allowance.resetsAt))
      ? null
      : allowance.resetsAt;
  if (allowance.exhausted) {
    return { kind: 'usedUp', resetsAt };
  }
  if (allowance.remainingPercent === null) {
    return { kind: 'unlimited' };
  }
  return {
    kind: 'remaining',
    percent: Math.min(100, Math.max(0, Math.round(allowance.remainingPercent))),
    resetsAt,
  };
}
