import { cookies } from 'next/headers';
import {
  DEFAULT_LOCALE,
  isLocale,
  resolveDirection,
  type Direction,
  type Locale,
} from '@integr8/i18n/core';
import { LOCALE_COOKIE, THEME_COOKIE } from './cookies';

/**
 * Locale, direction and theme, resolved on the server.
 *
 * Server-side so `<html lang dir>` is correct in the first byte. Resolving it
 * in the browser instead produces a visible flash as a right-to-left layout
 * snaps into place after hydration — and on a slow connection that flash is a
 * second long.
 *
 * Direction follows the locale and nothing else.
 *
 * **English first, always** (Low 3). The language is English unless the
 * person chose Arabic, with the switch on the public pages; that choice is the
 * locale cookie,
 * and it is remembered. The browser's `Accept-Language` is not consulted any
 * more: a visitor whose system happens to be Arabic still opens the site in
 * English, the way the owner wants it introduced, one click away from Arabic.
 */

export { LOCALE_COOKIE, THEME_COOKIE } from './cookies';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface Preferences {
  locale: Locale;
  direction: Direction;
  theme: ThemePreference;
}

export async function readPreferences(): Promise<Preferences> {
  const cookieStore = await cookies();

  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
  const theme = readTheme(cookieStore.get(THEME_COOKIE)?.value);

  return { locale, direction: resolveDirection(locale), theme };
}

/** The remembered choice when there is a valid one, otherwise English. */
export function resolveLocale(chosen: string | undefined): Locale {
  return chosen !== undefined && isLocale(chosen) ? chosen : DEFAULT_LOCALE;
}

function readTheme(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
