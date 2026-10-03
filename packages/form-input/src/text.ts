import type { LocalizedText } from '@integr8/form-engine';

/** Text an admin wrote, in the language shown: that language, then English, then any. */
export function say(
  text: LocalizedText | Readonly<Record<string, string>> | undefined,
  locale: string,
): string {
  if (text === undefined) {
    return '';
  }
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Digits as the engine stores them.
 *
 * An Arabic keyboard types ٣٫٥, and a Persian one ۳٫۵; the engine stores 3.5.
 * Converting here, as the person types, is what lets a number question work
 * in the language the form is filled in without the engine learning about
 * scripts.
 */
export function normaliseDigits(value: string): string {
  let result = '';
  for (const character of value) {
    const arabic = ARABIC_INDIC.indexOf(character);
    const eastern = EASTERN_ARABIC_INDIC.indexOf(character);
    if (arabic !== -1) {
      result += String(arabic);
    } else if (eastern !== -1) {
      result += String(eastern);
    } else if (character === '٫') {
      result += '.';
    } else if (character === '−') {
      result += '-';
    } else {
      result += character;
    }
  }
  return result;
}

/** `+03:00` for an offset east of UTC in minutes, as `Date#getTimezoneOffset` negated gives it. */
export function offsetText(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/**
 * A date-time answer from a local `YYYY-MM-DDTHH:MM` and the offset in force at
 * that moment. The engine requires the offset: 14:05 in Cairo and in Frankfurt
 * are different instants.
 */
export function withOffset(local: string, offsetMinutes: number): string {
  return `${local}:00${offsetText(offsetMinutes)}`;
}

/** `withOffset` with this device's offset on that date — summer time included. */
export function withLocalOffset(local: string): string {
  return withOffset(local, -new Date(local).getTimezoneOffset());
}

/** Bytes as a person reads them. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit] ?? 'B'}`;
}
