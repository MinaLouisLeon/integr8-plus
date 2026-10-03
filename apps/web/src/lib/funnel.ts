import { apiClient } from './session';

/**
 * Telling the API that somebody reached a step (P18).
 *
 * The exit criterion is *the funnel is instrumented and drop-off is visible per
 * step*, and the steps worth seeing are the ones before anybody has an account.
 * So the public pages report themselves.
 *
 * Three properties, all deliberate:
 *
 * - **It never blocks and never throws.** A page that failed to render because
 *   analytics was down would be a page that punished us for measuring it.
 * - **It carries nothing about the person.** A step name and, at most, which
 *   plan they were looking at. No address, no id, no fingerprint — the table
 *   behind it answers "how many gave up here", never "who".
 * - **It fires once per page view.** `sessionStorage` keeps the set of steps
 *   already reported, so React re-rendering or a person using the back button
 *   does not inflate the top of the funnel. It is per tab, which is the closest
 *   honest approximation of "a visit" available without a cookie.
 */

type Step = 'landing.viewed' | 'features.viewed' | 'pricing.viewed' | 'signup.opened';

const KEY = 'integr8.funnel.reported';

function alreadyReported(step: string): boolean {
  try {
    const raw = sessionStorage.getItem(KEY);
    const seen = raw === null ? [] : (JSON.parse(raw) as string[]);
    if (seen.includes(step)) {
      return true;
    }
    sessionStorage.setItem(KEY, JSON.stringify([...seen, step]));
    return false;
  } catch {
    // Private browsing, blocked storage, a quota. Report it and accept the
    // occasional double count: a missing step is worse than a duplicated one.
    return false;
  }
}

export function recordFunnelStep(step: Step, plan?: string): void {
  if (alreadyReported(step)) {
    return;
  }

  void apiClient()
    .POST('/v1/signup/step', {
      body: { step, ...(plan === undefined ? {} : { plan: plan as 'starter' }) },
    })
    .catch(() => {
      // Deliberately silent. Nothing about this page depends on it.
    });
}
