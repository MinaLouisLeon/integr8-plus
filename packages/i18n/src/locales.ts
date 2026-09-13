/**
 * The locales this product knows about, and which way each one reads.
 *
 * Arabic is declared here now, in P05, with no Arabic copy behind it. That is
 * deliberate and it is the whole reason the RTL task sits in this phase rather
 * than in P32: selecting `ar` today gives English words in a right-to-left
 * layout, which is exactly the test that proves a screen was built with logical
 * properties rather than hardcoded `left` and `right`.
 *
 * Retrofitting that into screens built the other way is a rewrite. Checking it
 * as each screen is built costs nothing.
 */

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export type Direction = 'ltr' | 'rtl';

export const LOCALE_DIRECTION: Readonly<Record<Locale, Direction>> = Object.freeze({
  en: 'ltr',
  ar: 'rtl',
});

/** Locales with translations of their own. The rest fall back to English. */
export const TRANSLATED_LOCALES: readonly Locale[] = ['en'];

export interface LocaleDescriptor {
  code: Locale;
  /** The language's name in that language, which is what a switcher shows. */
  nativeName: string;
  englishName: string;
  direction: Direction;
  translated: boolean;
}

export const LOCALE_DESCRIPTORS: readonly LocaleDescriptor[] = [
  {
    code: 'en',
    nativeName: 'English',
    englishName: 'English',
    direction: 'ltr',
    translated: true,
  },
  {
    // Named in Arabic because a person looking for their own language scans for
    // its own name, not for the English one.
    code: 'ar',
    nativeName: 'العربية',
    englishName: 'Arabic',
    direction: 'rtl',
    translated: false,
  },
];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function directionFor(locale: string): Direction {
  return isLocale(locale) ? LOCALE_DIRECTION[locale] : 'ltr';
}

export function isRtl(locale: string): boolean {
  return directionFor(locale) === 'rtl';
}

/**
 * Picks the best locale from what a browser or device asks for.
 *
 * Matches on the language subtag, so `ar-EG` and `ar-SA` both resolve to `ar`.
 * Regional variants are a P32 conversation; guessing wrong between them shows
 * somebody the right language, which is the part that matters.
 */
export function negotiateLocale(
  requested: readonly string[],
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  for (const candidate of requested) {
    const language = candidate.split('-')[0]?.toLowerCase() ?? '';
    if (isLocale(language)) {
      return language;
    }
  }
  return fallback;
}
