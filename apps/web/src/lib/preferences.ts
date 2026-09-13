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

/**
 * Locale, direction and theme, resolved on the server.
 *
 * Server-side so `<html lang dir>` is correct in the first byte. Resolving it
 * in the browser instead produces a visible flash as a right-to-left layout
 * snaps into place after hydration — and on a slow connection that flash is a
 * second long.
 */

export const LOCALE_COOKIE = 'integr8_locale';
export const RTL_PREVIEW_COOKIE = 'integr8_force_rtl';
export const THEME_COOKIE = 'integr8_theme';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface Preferences {
  locale: Locale;
  direction: Direction;
  theme: ThemePreference;
  forceRtl: boolean;
}

export async function readPreferences(): Promise<Preferences> {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const chosen = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale =
    chosen !== undefined && isLocale(chosen)
      ? chosen
      : negotiateLocale(acceptedLanguages(headerStore.get('accept-language')), DEFAULT_LOCALE);

  const forceRtl = cookieStore.get(RTL_PREVIEW_COOKIE)?.value === 'true';
  const theme = readTheme(cookieStore.get(THEME_COOKIE)?.value);

  return { locale, direction: resolveDirection(locale, forceRtl), theme, forceRtl };
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
