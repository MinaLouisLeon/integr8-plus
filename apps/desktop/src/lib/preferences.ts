import { DEFAULT_LOCALE, isLocale, resolveDirection, type Locale } from '@integr8/i18n/core';

/**
 * The person's own preferences: today, the language alone.
 *
 * The theme used to live here too. It is the company's now — see
 * `company-theme.ts` — because a company's app wears the company's look, and
 * the direction follows the locale alone, because a right-to-left preview was
 * a development toggle and Arabic is now a real locale.
 *
 * `localStorage` is fine here — and only here. These are display preferences,
 * not credentials: the worst an attacker gains by reading or writing them is a
 * page in the wrong language. Tokens go in the OS keychain; see `platform.ts`.
 */

const LOCALE_KEY = 'integr8.locale';

export interface Preferences {
  locale: Locale;
}

export function readPreferences(): Preferences {
  const stored = readStorage(LOCALE_KEY);

  return {
    locale: stored !== undefined && isLocale(stored) ? stored : DEFAULT_LOCALE,
  };
}

export function writePreferences(next: Partial<Preferences>): void {
  if (next.locale !== undefined) {
    writeStorage(LOCALE_KEY, next.locale);
  }
}

/**
 * Applies the preferences to the document.
 *
 * One attribute mirrors the whole interface, because every style in this app
 * uses logical properties. That is the payoff for doing the RTL work in P05
 * rather than retrofitting it in P32.
 */
export function applyPreferences(preferences: Preferences): void {
  const root = document.documentElement;

  root.lang = preferences.locale;
  root.dir = resolveDirection(preferences.locale);
}

/** A `localStorage` read that treats a blocked store as an empty one. */
export function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    // Private browsing, or storage disabled by policy. A missing preference is
    // a default, not a failure.
    return undefined;
  }
}

/** A `localStorage` write that treats a blocked store as a value that does not persist. */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // As above: the preference simply does not persist.
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to remove, or nowhere to remove it from.
  }
}
