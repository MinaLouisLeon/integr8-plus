/**
 * Exact decimals for ETA amounts: a BigInt and a scale, never a float.
 *
 * SPEC-UNVERIFIED(rounding): amounts are rounded half away from zero to five
 * places. Five places is what the ETA's validation rules allow as recalled;
 * the rounding direction is the usual commercial one and must be confirmed.
 */

export interface Decimal {
  /** The value times 10^scale. */
  readonly units: bigint;
  readonly scale: number;
}

export const ETA_SCALE = 5;

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/u;

export function parseDecimal(text: string): Decimal {
  const match = DECIMAL.exec(text.trim());
  if (match === null) {
    throw new TypeError(`Not a decimal: ${text}`);
  }
  const fraction = match[3] ?? '';
  const units = BigInt(`${match[2] ?? '0'}${fraction}`);
  return { units: match[1] === '-' ? -units : units, scale: fraction.length };
}

export function isDecimalText(text: string): boolean {
  return DECIMAL.test(text.trim());
}

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

function rescaleUp(value: Decimal, scale: number): bigint {
  return value.units * pow10(scale - value.scale);
}

export function decimal(units: bigint | number, scale = 0): Decimal {
  return { units: BigInt(units), scale };
}

export const ZERO: Decimal = { units: 0n, scale: 0 };

export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescaleUp(a, scale) + rescaleUp(b, scale), scale };
}

export function sub(a: Decimal, b: Decimal): Decimal {
  return add(a, { units: -b.units, scale: b.scale });
}

export function mul(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** Divides by a power of ten: a basis-point rate becomes a fraction with no rounding. */
export function shift(a: Decimal, places: number): Decimal {
  return { units: a.units, scale: a.scale + places };
}

/** Rounds half away from zero to `scale` places. */
export function round(value: Decimal, scale: number = ETA_SCALE): Decimal {
  if (value.scale <= scale) {
    return { units: rescaleUp(value, scale), scale };
  }
  const divisor = pow10(value.scale - scale);
  const negative = value.units < 0n;
  const magnitude = negative ? -value.units : value.units;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) {
    quotient += 1n;
  }
  return { units: negative ? -quotient : quotient, scale };
}

export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const x = rescaleUp(a, scale);
  const y = rescaleUp(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce(add, ZERO);
}

/**
 * The lexeme written into a document: rounded to `scale`, trailing zeros and
 * a bare point dropped, never `-0`.
 */
export function formatDecimal(value: Decimal, scale: number = ETA_SCALE): string {
  const rounded = round(value, scale);
  const negative = rounded.units < 0n;
  const digits = (negative ? -rounded.units : rounded.units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, '');
  const text = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative && text !== '0' ? `-${text}` : text;
}

/** A basis-point rate as a percentage lexeme: 1400 → "14", 1250 → "12.5". */
export function percentFromBasisPoints(basisPoints: number): Decimal {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError('Basis points are a non-negative integer');
  }
  return { units: BigInt(basisPoints), scale: 2 };
}

/** A basis-point rate as a fraction: 1400 → 0.14. */
export function fractionFromBasisPoints(basisPoints: number): Decimal {
  return shift(percentFromBasisPoints(basisPoints), 2);
}
