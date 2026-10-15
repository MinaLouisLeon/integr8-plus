import { ApiRequestError } from '@integr8/api-client';

/**
 * The assistant's answers, read for the phone (docs/ai §10.4).
 *
 * Pure: what a citation's route key means on this app, which usage axis is
 * used up, and when a refused question may be asked again. The screen does
 * the rest.
 */

/** One counter: a day's or a month's messages, the company's or the member's. */
export interface UsageAxis {
  used: number;
  reserved: number;
  limit: number | null;
  remaining: number | null;
  resetsAt: string;
}

export interface Usage {
  daily: UsageAxis | null;
  monthly: UsageAxis | null;
  user: { daily: UsageAxis; monthly: UsageAxis };
  unlimited: boolean;
}

export type UsageScope = 'company' | 'you';
export type UsagePeriod = 'daily' | 'monthly';

export interface LimitedAxis {
  scope: UsageScope;
  period: UsagePeriod;
  axis: UsageAxis;
}

/**
 * The axes with a limit, in the order a person reads them: the company's day
 * and month, then their own. An axis the policy does not limit is not shown.
 */
export function limitedAxes(usage: Usage): LimitedAxis[] {
  const all: { scope: UsageScope; period: UsagePeriod; axis: UsageAxis | null }[] = [
    { scope: 'company', period: 'daily', axis: usage.daily },
    { scope: 'company', period: 'monthly', axis: usage.monthly },
    { scope: 'you', period: 'daily', axis: usage.user.daily },
    { scope: 'you', period: 'monthly', axis: usage.user.monthly },
  ];
  return all.flatMap(({ scope, period, axis }) =>
    axis?.limit == null ? [] : [{ scope, period, axis }],
  );
}

/** The first axis with nothing left, so the composer can say when it resets; null while any is left. */
export function exhaustedAxis(usage: Usage): LimitedAxis | null {
  return (
    limitedAxes(usage).find(({ axis }) => axis.remaining !== null && axis.remaining <= 0) ?? null
  );
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

/** When a question refused for a used-up quota may be asked again, from the refusal's details. */
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
