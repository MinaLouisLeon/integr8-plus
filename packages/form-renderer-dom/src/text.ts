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

/** `2026-09-13T14:05` from a date-time input, with this device's offset, which the engine requires. */
export function withLocalOffset(local: string): string {
  const offset = -new Date(local).getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${local}:00${sign}${hours}:${minutes}`;
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
