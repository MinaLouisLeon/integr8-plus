/**
 * Exact decimal arithmetic.
 *
 * A decimal field holding a pipe diameter, a torque reading or a price cannot be
 * a JavaScript number. `0.1 + 0.2` is `0.30000000000000004`; a calculated field
 * that sums three such readings would render one value on the phone that took
 * them and store a subtly different one on the server that revalidates them.
 *
 * So a decimal is an integer count of units at a fixed scale — `12.50` is
 * `1250` at scale 2 — held in a `BigInt`, and the text form is the stored form.
 *
 * Written without `BigInt` literals (`10n`) or `**`: both are exactly the kind
 * of syntax a bundler lowers differently for an older JavaScript engine, and
 * `BigInt(10)` means the same thing everywhere.
 */

export interface Decimal {
  /** The value multiplied by `10 ** scale`. */
  readonly units: bigint;
  /** Digits after the decimal point. */
  readonly scale: number;
}

/** Enough for any measurement a field engineer takes; small enough to bound work. */
export const MAX_SCALE = 12;

/** Total significant digits accepted on input. Bounds the cost of one comparison. */
export const MAX_DIGITS = 30;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
const TWO = BigInt(2);

/**
 * Plain decimal notation only: an optional minus, no leading zeros, an optional
 * fraction. No `+`, no exponent, no leading or trailing point.
 *
 * Strict on purpose. A value typed as `1e3` or `.5` is a value one runtime might
 * read and another reject; the renderer normalises input before it gets here.
 */
const DECIMAL_TEXT = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

const POWERS: bigint[] = [ONE];

/** `10 ** exponent` as a bigint, cached. */
function pow10(exponent: number): bigint {
  while (POWERS.length <= exponent) {
    POWERS.push((POWERS[POWERS.length - 1] ?? ONE) * TEN);
  }
  return POWERS[exponent] ?? ONE;
}

export function parseDecimal(text: string): Decimal | undefined {
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) {
    return undefined;
  }

  const fraction = match[1] ?? '';
  if (fraction.length > MAX_SCALE) {
    return undefined;
  }

  const digits = text.replace('-', '').replace('.', '');
  if (digits.replace(/^0+/, '').length > MAX_DIGITS) {
    return undefined;
  }

  return { units: BigInt(text.replace('.', '')), scale: fraction.length };
}

/** Digits after the point as typed, which is what a "decimal places" limit is about. */
export function fractionDigits(text: string): number {
  const point = text.indexOf('.');
  return point === -1 ? 0 : text.length - point - 1;
}

export function fromInteger(value: number): Decimal {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${String(value)} is not a safe integer`);
  }
  return { units: BigInt(value), scale: 0 };
}

/** Text with exactly `scale` fraction digits. Negative zero prints as zero. */
export function formatDecimal(value: Decimal): string {
  const negative = value.units < ZERO;
  const magnitude = (negative ? -value.units : value.units).toString();

  let text: string;
  if (value.scale === 0) {
    text = magnitude;
  } else {
    const padded = magnitude.padStart(value.scale + 1, '0');
    const whole = padded.slice(0, padded.length - value.scale);
    text = `${whole}.${padded.slice(padded.length - value.scale)}`;
  }

  return negative && value.units !== ZERO ? `-${text}` : text;
}

function aligned(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * pow10(scale - a.scale),
    b: b.units * pow10(scale - b.scale),
    scale,
  };
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const values = aligned(a, b);
  if (values.a < values.b) {
    return -1;
  }
  return values.a > values.b ? 1 : 0;
}

export function add(a: Decimal, b: Decimal): Decimal {
  const values = aligned(a, b);
  return { units: values.a + values.b, scale: values.scale };
}

export function subtract(a: Decimal, b: Decimal): Decimal {
  const values = aligned(a, b);
  return { units: values.a - values.b, scale: values.scale };
}

/**
 * Exact. The scale grows by the sum of both, and is brought back down by the
 * caller rescaling to the target field's decimal places — not here, where the
 * target is not known.
 */
export function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/**
 * `a / b` at `scale`, rounded half away from zero.
 *
 * Half away from zero rather than banker's rounding: it is what a person doing
 * the sum on a calculator expects, and a job sheet that disagrees with the
 * engineer's own arithmetic generates a support call.
 *
 * `undefined` for a zero divisor. A calculation dividing by an unanswered or
 * zero reading has no value; it does not have the value infinity.
 */
export function divide(a: Decimal, b: Decimal, scale: number): Decimal | undefined {
  if (b.units === ZERO) {
    return undefined;
  }

  // (a.units / 10^a.scale) / (b.units / 10^b.scale) * 10^scale
  //   = a.units * 10^(scale + b.scale) / (b.units * 10^a.scale)
  const numerator = a.units * pow10(scale + b.scale);
  const denominator = b.units * pow10(a.scale);

  return { units: roundQuotient(numerator, denominator), scale };
}

/** The same value at a different scale, rounded half away from zero when shrinking. */
export function rescale(value: Decimal, scale: number): Decimal {
  if (scale >= value.scale) {
    return { units: value.units * pow10(scale - value.scale), scale };
  }
  return { units: roundQuotient(value.units, pow10(value.scale - scale)), scale };
}

function roundQuotient(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === ZERO) {
    return quotient;
  }

  const absRemainder = remainder < ZERO ? -remainder : remainder;
  const absDenominator = denominator < ZERO ? -denominator : denominator;
  if (absRemainder * TWO < absDenominator) {
    return quotient;
  }

  const negative = numerator < ZERO !== denominator < ZERO;
  return negative ? quotient - ONE : quotient + ONE;
}

/** Whether the value is a whole number, whatever its scale. */
export function isInteger(value: Decimal): boolean {
  return value.units % pow10(value.scale) === ZERO;
}
