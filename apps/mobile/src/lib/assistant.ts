import { ApiRequestError } from '@integr8/api-client';

/**
 * The assistant's answers, read for the phone (docs/ai §10.4).
 *
 * Pure: what a citation's route key means on this app, what the person is
 * told about their allowance, and when a refused question may be asked again.
 * The screen does the rest.
 */

/**
 * What is left of this person's share of the company's allowance
 * (ADR-0002 D6, D7). A percentage and a reset time only: the server never
 * sends a token count, a message count or a price, and neither does the screen.
 */
export interface Allowance {
  /** 0–100; null when nothing is limited. */
  remainingPercent: number | null;
  resetsAt: string | null;
  /** True when a question would be refused now. */
  exhausted: boolean;
}

/** The one line the screen says about the allowance, or nothing at all. */
export type AllowanceLine =
  | { kind: 'remaining'; percent: number; resetsAt: string | null }
  | { kind: 'usedUp'; resetsAt: string | null }
  | null;

/**
 * The allowance as one line. Used up wins over any percentage, because the
 * server decides "exhausted" from every limit it checks, the company's pool
 * included, and a member's own share can show some left while the pool is not.
 * Nothing limited is nothing said: a line reading "no limit" invites the
 * question of whose limit, which this screen cannot answer.
 */
export function allowanceLine(allowance: Allowance): AllowanceLine {
  if (allowance.exhausted) {
    return { kind: 'usedUp', resetsAt: validInstant(allowance.resetsAt) };
  }
  if (allowance.remainingPercent === null) {
    return null;
  }
  return {
    kind: 'remaining',
    percent: Math.min(100, Math.max(0, Math.round(allowance.remainingPercent))),
    resetsAt: validInstant(allowance.resetsAt),
  };
}

/**
 * Why the composer is closed, and until when; null while a question may be
 * sent. Closed by the allowance the server last reported, or by a quota
 * refusal the server just gave. A reset time already passed opens it again:
 * the screen may have been open across midnight, and the server says so if
 * the allowance is still used up.
 */
export function sendBlock(
  allowance: Allowance,
  refusedUntil: string | null,
  now: number,
): { resetsAt: string | null } | null {
  if (allowance.exhausted) {
    const resetsAt = validInstant(allowance.resetsAt);
    if (resetsAt === null || Date.parse(resetsAt) > now) {
      return { resetsAt };
    }
  }
  if (refusedUntil !== null && Date.parse(refusedUntil) > now) {
    return { resetsAt: refusedUntil };
  }
  return null;
}

function validInstant(value: string | null): string | null {
  return value === null || Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * The route keys the server's help articles and actions point at, as this
 * app's screens. The phone has no screen for most of the office's modules, so
 * most keys map to nothing and the citation is just a label.
 */
const SCREENS: ReadonlyMap<string, string> = new Map([
  ['workOrders', '/home'],
  ['customers', '/home'],
  ['myExpenses', '/expenses'],
  ['payRuns', '/payslips'],
  ['purchaseOrders', '/receive'],
  ['inventory', '/van'],
  ['stockLocations', '/van'],
  ['assets', '/assets/scan'],
]);

/** The screen a route key opens on the phone, or null when the phone has none for it. */
export function screenForAppRoute(appRoute: string | null): string | null {
  return appRoute === null ? null : (SCREENS.get(appRoute) ?? null);
}

/**
 * When a question refused for a used-up allowance may be asked again, from
 * the refusal's details. Every quota refusal is a 429 carrying `resetsAt` —
 * the message quotas, the token quotas (`ai_daily_token_quota_exceeded`,
 * `ai_monthly_token_quota_exceeded`) and a member's monthly budget
 * (`ai_member_budget_exceeded`) alike — so the shape is read rather than a
 * list of codes that the next limit would fall outside. A 429 without it (too
 * many at once) is not a quota and may be retried now.
 */
export function quotaResetsAt(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 429) {
    return null;
  }
  const resetsAt = error.details[0]?.params?.resetsAt;
  return resetsAt === undefined || Number.isNaN(Date.parse(resetsAt)) ? null : resetsAt;
}

/** The language a conversation is held in: the app's, as far as the server speaks it. */
export function assistantLocale(language: string): 'en' | 'ar' {
  return language.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/** The length the server accepts for one question. */
export const MAX_QUESTION_CHARS = 4000;
