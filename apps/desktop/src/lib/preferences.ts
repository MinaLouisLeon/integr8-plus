import { DEFAULT_LOCALE, isLocale, resolveDirection, type Locale } from '@integr8/i18n/core';

/**
 * Locale, theme and the right-to-left preview.
 *
 * `localStorage` is fine here — and only here. These are display preferences,
 * not credentials: the worst an attacker gains by reading or writing them is a
 * page in the wrong language. Tokens go in the OS keychain; see `platform.ts`.
 */

const LOCALE_KEY = 'integr8.locale';
const THEME_KEY = 'integr8.theme';
const RTL_KEY = 'integr8.forceRtl';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface Preferences {
  locale: Locale;
  theme: ThemePreference;
  forceRtl: boolean;
}

export function readPreferences(): Preferences {
  const stored = safeRead(LOCALE_KEY);
  const theme = safeRead(THEME_KEY);

  return {
    locale: stored !== undefined && isLocale(stored) ? stored : DEFAULT_LOCALE,
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    forceRtl: safeRead(RTL_KEY) === 'true',
  };
}

export function writePreferences(next: Partial<Preferences>): void {
  if (next.locale !== undefined) {
    safeWrite(LOCALE_KEY, next.locale);
  }
  if (next.theme !== undefined) {
    safeWrite(THEME_KEY, next.theme);
  }
  if (next.forceRtl !== undefined) {
    safeWrite(RTL_KEY, String(next.forceRtl));
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
  root.dir = resolveDirection(preferences.locale, preferences.forceRtl);

  if (preferences.theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.dataset.theme = preferences.theme;
  }
}

function safeRead(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    // Private browsing, or storage disabled by policy. A missing preference is
    // a default, not a failure.
    return undefined;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // As above: the preference simply does not persist.
  }
}
