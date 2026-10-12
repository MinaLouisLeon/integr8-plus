/**
 * Quantities and amounts as the API sends them: decimal strings of up to four
 * places. Never a JavaScript number on the way — `0.1 + 0.2` is not `0.3` —
 * so they are added and compared as whole numbers of ten-thousandths.
 */

/** Digits with up to four decimal places: what the API takes for a quantity or an amount. */
export const DECIMAL = /^\d{1,16}(\.\d{1,4})?$/u;

const PLACES = 4;

/** Whether `text` is a decimal the API takes, above zero. */
export function isPositiveDecimal(text: string): boolean {
  const value = text.trim();
  return DECIMAL.test(value) && /[1-9]/u.test(value);
}

/** Whether `text` is a decimal the API takes, zero included. */
export function isDecimal(text: string): boolean {
  return DECIMAL.test(text.trim());
}

function units(text: string): bigint {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(
    `${whole === '' ? '0' : whole}${fraction.padEnd(PLACES, '0').slice(0, PLACES)}`,
  );
  return negative ? -value : value;
}

function text(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(PLACES + 1, '0');
  const whole = digits.slice(0, -PLACES);
  const fraction = digits.slice(-PLACES).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

export function addDecimals(a: string, b: string): string {
  return text(units(a) + units(b));
}

/** `a - b`, never below zero. */
export function subtractDecimals(a: string, b: string): string {
  const left = units(a) - units(b);
  return text(left < 0n ? 0n : left);
}

export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const left = units(a);
  const right = units(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The same decimal in its shortest form: `2.50` is `2.5`, `007` is `7`. */
export function normaliseDecimal(value: string): string {
  return text(units(value.trim()));
}
