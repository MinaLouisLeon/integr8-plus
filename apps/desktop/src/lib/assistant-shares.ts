import { ApiRequestError } from '@integr8/api-client';

/**
 * The small decisions the two screens that set assistant shares make alike:
 * the company's People page and the platform's company page (ADR-0002 D6, D7).
 *
 * Here rather than inline because both send the same body and read the same
 * refusals, and a share typed as "12.5" or a dollar cap typed as "0.1" should
 * be judged the same way in both places.
 */

/**
 * A share as typed: empty is no share (null), a whole number from 1 to 100 is
 * that share, and anything else is not something to send.
 */
export function parseSharePercent(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^\d{1,3}$/u.test(trimmed)) {
    return 'invalid';
  }
  const percent = Number(trimmed);
  return percent >= 1 && percent <= 100 ? percent : 'invalid';
}

/**
 * How much of the company's allowance is still unassigned, from a refusal for
 * passing 100% (`ai_shares_over_total`): the API puts it in the detail's
 * params, as a string, so the screen can say how far the share may go.
 */
export function unassignedFromRefusal(failure: unknown): number | null {
  if (!(failure instanceof ApiRequestError) || failure.code !== 'ai_shares_over_total') {
    return null;
  }
  const raw = failure.details.find((detail) => detail.params?.availablePercent !== undefined)
    ?.params?.availablePercent;
  if (raw === undefined) {
    return null;
  }
  const percent = Number(raw);
  return Number.isInteger(percent) ? percent : null;
}

/**
 * A monthly dollar cap as typed, in whole US dollars and cents, as integer
 * micros (1 USD = 1,000,000). Empty is no cap (null). The conversion is done on
 * the digits, not in floating point, so "0.07" is 70,000 and never 69,999.
 * Up to six decimals are accepted, which is what a micro can hold; a cap of
 * zero is refused, because "no cap" is the empty field.
 */
export function parseUsdToMicros(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const match = /^(\d{1,9})(?:\.(\d{0,6}))?$/u.exec(trimmed);
  if (match === null) {
    return 'invalid';
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(6, '0'));
  const micros = whole * 1_000_000 + fraction;
  return micros > 0 ? micros : 'invalid';
}

/** Integer micros as the dollars an input shows: "12.5" for 12,500,000, no float arithmetic. */
export function microsToUsdInput(micros: number): string {
  const whole = Math.trunc(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '');
  return fraction === '' ? String(whole) : `${String(whole)}.${fraction}`;
}

/**
 * USD micros as money for the platform's eyes only, with two to four decimals:
 * a member's month is often a few cents, and "$0.00" would hide it.
 */
export function formatMicrousdPrecise(micros: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(micros / 1_000_000);
}
