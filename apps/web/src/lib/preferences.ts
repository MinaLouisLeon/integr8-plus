import { cookies } from 'next/headers';
import {
  DEFAULT_LOCALE,
  isLocale,
  negotiateLocale,
  resolveDirection,
  type Direction,
  type Locale,
} from '@integr8/i18n/core';
import { headers } from 'next/headers';
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
  const headerStore = await headers();

  const chosen = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale =
    chosen !== undefined && isLocale(chosen)
      ? chosen
      : negotiateLocale(acceptedLanguages(headerStore.get('accept-language')), DEFAULT_LOCALE);

  const theme = readTheme(cookieStore.get(THEME_COOKIE)?.value);
  const sidebar = readSidebar(cookieStore.get(SIDEBAR_COOKIE)?.value);

  return { locale, direction: resolveDirection(locale), theme, sidebar };
}

/** `en-GB,en;q=0.9,ar;q=0.8` → `['en-GB', 'en', 'ar']`, best first. */
export function acceptedLanguages(header: string | null): string[] {
  if (header === null) {
    return [];
  }

  return header
    .split(',')
    .map((part) => {
      const [tag, quality] = part.trim().split(';q=');
      return { tag: tag?.trim() ?? '', quality: Number.parseFloat(quality ?? '1') };
    })
    .filter((entry) => entry.tag !== '')
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.tag);
}

function readTheme(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readSidebar(value: string | undefined): SidebarState {
  return value === 'collapsed' ? 'collapsed' : 'expanded';
}
