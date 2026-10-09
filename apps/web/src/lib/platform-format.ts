/**
 * The small formatting decisions the dashboard makes over and over (P15).
 *
 * Here rather than inline in the screens because each one is a judgement that
 * should be made once and be testable: how big is "big", when a date stops
 * being useful and a duration starts, and what a slug looks like.
 */

/**
 * Bytes, in the unit a person would say out loud.
 *
 * Powers of 1000 with SI names, which is what storage is sold and billed in.
 * Using 1024 and calling it MB is the discrepancy that makes an invoice look
 * wrong, and being consistent with Cloudflare matters more here than being
 * consistent with a file manager.
 */
export function formatBytes(bytes: number, locale = 'en'): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1000) {
    return `${String(Math.round(bytes))} B`;
  }

  const units = ['kB', 'MB', 'GB', 'TB', 'PB'] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  // One decimal place below 10, none above: "1.4 GB" and "812 GB" both read as
  // one number rather than as spurious precision.
  const digits = value < 10 ? 1 : 0;
  return `${value.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${units[unit] ?? 'PB'}`;
}

/**
 * How long a grant lasted, in the coarsest unit that is still true.
 *
 * Impersonation lasts minutes, so seconds matter at the short end and nothing
 * beyond hours matters at the long end.
 */
export function formatDuration(seconds: number | null): string | undefined {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  if (seconds < 60) {
    return `${String(Math.round(seconds))}s`;
  }
  if (seconds < 3600) {
    return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
  }
  return `${String(Math.floor(seconds / 3600))}h ${String(Math.floor((seconds % 3600) / 60))}m`;
}

/** A timestamp, or a dash. The dash is deliberate: an empty cell reads as a bug. */
export function formatWhen(iso: string | null | undefined, locale = 'en'): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(iso: string | null | undefined, locale = 'en'): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(locale, { dateStyle: 'medium' });
}

/**
 * Suggests a slug from a company's name.
 *
 * A suggestion only: the field stays editable, because a slug cannot be changed
 * afterwards and nobody should discover theirs was guessed badly a year later.
 */
export function suggestSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      // NFKD splits the accent off `å` but not the stroke off `ø`, so the marks
      // are dropped first and the handful of letters it cannot decompose are
      // mapped by hand. Without this, "Ålesund Rør" suggests "a-lesund-r-r".
      .replaceAll(/\p{M}+/gu, '')
      .toLowerCase()
      .replaceAll(/[øœ]/gu, 'o')
      .replaceAll(/[æ]/gu, 'ae')
      .replaceAll(/[ð]/gu, 'd')
      .replaceAll(/[þ]/gu, 'th')
      .replaceAll(/[ł]/gu, 'l')
      .replaceAll(/[ß]/gu, 'ss')
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 63)
      .replaceAll(/-+$/gu, '')
  );
}

/** True when this is a slug the API will accept, so the form can say so first. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u.test(slug) && slug.length >= 2 && slug.length <= 63;
}

/**
 * Picks the text to show from a message keyed by language tag.
 *
 * Falls back to English, then to whatever is there. An announcement with no
 * translation for the reader's language is still worth showing — it is usually
 * the one saying the system is about to go down.
 */
export function pickMessage(message: Record<string, string>, locale: string): string {
  const exact = message[locale];
  if (exact !== undefined) {
    return exact;
  }
  const base = locale.split('-')[0] ?? locale;
  return message[base] ?? message.en ?? Object.values(message)[0] ?? '';
}

/** The API's own rule for a company website: https only, no spaces, at most 2048 characters. */
export function isValidWebsite(value: string): boolean {
  return /^https:\/\/\S+$/u.test(value) && value.length <= 2048;
}
