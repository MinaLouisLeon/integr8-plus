import { DEFAULT_LOCALE, isLocale, negotiateLocale, type Locale } from '@integr8/i18n/core';
import { getLocales } from 'expo-localization';

/**
 * Which language the phone is set to.
 *
 * Read from the device rather than stored: a phone's language is a setting the
 * person already made, and asking again in the app is asking twice. P32 adds a
 * per-account override when there is Arabic copy to override with.
 */
export function deviceLocale(): Locale {
  try {
    const tags = getLocales()
      .map((entry) => entry.languageTag)
      .filter((tag): tag is string => typeof tag === 'string');

    return negotiateLocale(tags, DEFAULT_LOCALE);
  } catch {
    // `expo-localization` needs a native module. In a unit test there is not
    // one, and a default is a better answer than a crash.
    return DEFAULT_LOCALE;
  }
}

export { isLocale };
