import { cookies } from 'next/headers';
import {
  DEFAULT_LOCALE,
  isLocale,
  resolveDirection,
  type Direction,
  type Locale,
} from '@integr8/i18n/core';
import { LOCALE_COOKIE, SIDEBAR_COOKIE, THEME_COOKIE } from './cookies';

/**
 * Locale, direction, theme and the menu's state, resolved on the server.
 *
 * Server-side so `<html lang dir>` is correct in the first byte. Resolving it
 * in the browser instead produces a visible flash as a right-to-left layout
 * snaps into place after hydration — and on a slow connection that flash is a
 * second long. The same goes for the side menu: a menu that renders wide and
 * then collapses is a page that jumps.
 *
 * Direction follows the locale and nothing else. The theme is the company's,
 * written to its cookie by the shell once `/v1/me` says what it is.
 *
 * **English first, always** (Low 3). The language is English unless the
 * person chose Arabic, with the switch on the public pages or the language
 * menu in the workspace and the dashboard; that choice is the locale cookie,
 * and it is remembered. The browser's `Accept-Language` is not consulted any
 * more: a visitor whose system happens to be Arabic still opens the site in
 * English, the way the owner wants it introduced, one click away from Arabic.
 */

export { LOCALE_COOKIE, SIDEBAR_COOKIE, THEME_COOKIE } from './cookies';

export type ThemePreference = 'light' | 'dark' | 'system';
export type SidebarState = 'expanded' | 'collapsed';

export interface Preferences {
  locale: Locale;
  direction: Direction;
  theme: ThemePreference;
  sidebar: SidebarState;
}

export async function readPreferences(): Promise<Preferences> {
  const cookieStore = await cookies();

  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
  const theme = readTheme(cookieStore.get(THEME_COOKIE)?.value);
  const sidebar = readSidebar(cookieStore.get(SIDEBAR_COOKIE)?.value);

  return { locale, direction: resolveDirection(locale), theme, sidebar };
}

/** The remembered choice when there is a valid one, otherwise English. */
export function resolveLocale(chosen: string | undefined): Locale {
  return chosen !== undefined && isLocale(chosen) ? chosen : DEFAULT_LOCALE;
}

function readTheme(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readSidebar(value: string | undefined): SidebarState {
  return value === 'collapsed' ? 'collapsed' : 'expanded';
}
