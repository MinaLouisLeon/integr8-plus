import { DEFAULT_LOCALE } from './locales.js';

/**
 * Locale-aware formatting.
 *
 * Every date, number and currency a person reads goes through here. Not because
 * `toLocaleDateString` is hard, but because scattering it means every screen
 * picks its own options and the product shows four different date formats — and
 * because `03/04` means two different days on two sides of an ocean, which is a
 * real problem for a job sheet.
 *
 * `Intl` formatters are expensive to construct and cheap to reuse, so they are
 * cached by locale and options. A list of two hundred rows would otherwise
 * build two hundred identical formatters.
 */

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(
  key: string,
  build: () => T,
): T {
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing as T;
  }
  const created = build();
  cache.set(key, created);
  return created;
}

export interface FormatOptions {
  /**
   * Any BCP-47 tag, not only the app's own locales.
   *
   * Deliberately wider than `Locale`: the interface language and the formatting
   * locale are different questions. A company operating in Britain wants
   * `en-GB` dates and pounds whether or not `en-GB` is a language this product
   * has been translated into.
   */
  locale?: string;
  timeZone?: string;
}

/**
 * A date, without a time. `10 September 2026`.
 *
 * Long-form month by default rather than numeric, because `03/04/2026` is the
 * third of April in most of the world and the fourth of March in the United
 * States, and a job sheet is not the place to find that out.
 */
export function formatDate(value: Date | string, options: FormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const key = `date:${locale}:${options.timeZone ?? ''}`;

  return cached(
    key,
    () =>
      new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      }),
  ).format(toDate(value));
}

/** A date and a time. `10 September 2026 at 14:02`. */
export function formatDateTime(value: Date | string, options: FormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const key = `datetime:${locale}:${options.timeZone ?? ''}`;

  return cached(
    key,
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'long',
        timeStyle: 'short',
        ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      }),
  ).format(toDate(value));
}

/** A time alone. `14:02`. */
export function formatTime(value: Date | string, options: FormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const key = `time:${locale}:${options.timeZone ?? ''}`;

  return cached(
    key,
    () =>
      new Intl.DateTimeFormat(locale, {
        timeStyle: 'short',
        ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      }),
  ).format(toDate(value));
}

/**
 * `3 hours ago`, `in 2 days`.
 *
 * For "when was this device last used" and similar. Not for anything that has
 * to be precise: a relative time is friendly and lossy, and an audit entry
 * needs the timestamp.
 */
export function formatRelativeTime(
  value: Date | string,
  options: FormatOptions & { now?: Date } = {},
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const now = options.now ?? new Date();
  const elapsedMs = toDate(value).getTime() - now.getTime();

  const formatter = cached(
    `relative:${locale}`,
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
  );

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ];

  for (const [unit, ms] of units) {
    if (Math.abs(elapsedMs) >= ms) {
      return formatter.format(Math.round(elapsedMs / ms), unit);
    }
  }

  return formatter.format(Math.round(elapsedMs / 1000), 'second');
}

export function formatNumber(
  value: number,
  options: FormatOptions & { maximumFractionDigits?: number } = {},
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const digits = options.maximumFractionDigits ?? 2;

  return cached(
    `number:${locale}:${String(digits)}`,
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }),
  ).format(value);
}

/**
 * Money.
 *
 * The currency is a required argument rather than a default, deliberately.
 * A default currency is how an amount in one currency gets rendered with
 * another's symbol, and the number looks perfectly reasonable either way.
 */
export function formatCurrency(
  value: number,
  currency: string,
  options: FormatOptions = {},
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;

  return cached(
    `currency:${locale}:${currency}`,
    () => new Intl.NumberFormat(locale, { style: 'currency', currency }),
  ).format(value);
}

/** `45%`. Takes a fraction, so `0.45` rather than `45`. */
export function formatPercent(value: number, options: FormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE;

  return cached(
    `percent:${locale}`,
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
  ).format(value);
}

/**
 * A list, joined the way the locale joins lists.
 *
 * `a, b and c` in English; the conjunction and the commas differ elsewhere.
 * Joining with `', '` in code is the small mistake that makes a translated
 * screen read like a translated screen.
 */
export function formatList(values: readonly string[], options: FormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(values);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Empties the formatter cache. Tests use it; nothing else needs to. */
export function resetFormatterCache(): void {
  cache.clear();
}
