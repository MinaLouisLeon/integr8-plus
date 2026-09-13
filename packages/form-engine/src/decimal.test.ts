import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  add,
  compareDecimal,
  type Decimal,
  divide,
  formatDecimal,
  fractionDigits,
  fromInteger,
  isInteger,
  MAX_DIGITS,
  multiply,
  parseDecimal,
  rescale,
  subtract,
} from './decimal.js';

const d = (text: string): Decimal => {
  const parsed = parseDecimal(text);
  if (parsed === undefined) {
    throw new Error(`test value "${text}" did not parse`);
  }
  return parsed;
};

describe('parsing', () => {
  it.each(['0', '-0', '12', '-12', '12.5', '12.50', '0.001', '-0.001', '999999.999999'])(
    'accepts %s',
    (text) => {
      expect(parseDecimal(text)).toBeDefined();
    },
  );

  it.each([
    '',
    '-',
    '+1',
    '01',
    '1.',
    '.5',
    '1e3',
    '1,5',
    ' 1',
    '1 ',
    '0x10',
    'NaN',
    'Infinity',
    '1.2.3',
    '١٢',
  ])('refuses %j', (text) => {
    expect(parseDecimal(text)).toBeUndefined();
  });

  it('refuses more fraction digits than it can hold, and more significant digits', () => {
    expect(parseDecimal('1.1234567890123')).toBeUndefined();
    expect(parseDecimal('1'.repeat(MAX_DIGITS + 1))).toBeUndefined();
    expect(parseDecimal('1'.repeat(MAX_DIGITS))).toBeDefined();
  });

  it('keeps the scale as typed, so 12.50 and 12.5 are the same value at different scales', () => {
    expect(d('12.50')).toEqual({ units: BigInt(1250), scale: 2 });
    expect(compareDecimal(d('12.50'), d('12.5'))).toBe(0);
  });

  it('counts decimal places as typed', () => {
    expect(fractionDigits('12')).toBe(0);
    expect(fractionDigits('12.500')).toBe(3);
  });

  it('builds from safe integers only', () => {
    expect(fromInteger(-7)).toEqual({ units: BigInt(-7), scale: 0 });
    expect(() => fromInteger(0.5)).toThrow(RangeError);
    expect(() => fromInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe('formatting', () => {
  it.each([
    ['1250', 2, '12.50'],
    ['-5', 3, '-0.005'],
    ['0', 2, '0.00'],
    ['-0', 0, '0'],
    ['7', 0, '7'],
  ])('%s at scale %i is %s', (units, scale, expected) => {
    expect(formatDecimal({ units: BigInt(units), scale })).toBe(expected);
  });

  it('round-trips everything it parses, at the typed scale', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: BigInt(-1e15), max: BigInt(1e15) }),
        fc.integer({ min: 0, max: 6 }),
        (units, scale) => {
          const text = formatDecimal({ units, scale });
          expect(parseDecimal(text)).toEqual({ units, scale });
        },
      ),
    );
  });
});

describe('arithmetic', () => {
  it('is exact where floating point is not', () => {
    expect(formatDecimal(add(d('0.1'), d('0.2')))).toBe('0.3');
    expect(formatDecimal(subtract(d('1.10'), d('0.01')))).toBe('1.09');
    expect(formatDecimal(multiply(d('1.1'), d('1.1')))).toBe('1.21');
  });

  it('rounds half away from zero, in both directions', () => {
    expect(formatDecimal(rescale(d('2.5'), 0))).toBe('3');
    expect(formatDecimal(rescale(d('-2.5'), 0))).toBe('-3');
    expect(formatDecimal(rescale(d('2.49'), 0))).toBe('2');
    expect(formatDecimal(rescale(d('-2.49'), 0))).toBe('-2');
    expect(formatDecimal(rescale(d('0.125'), 2))).toBe('0.13');
    expect(formatDecimal(rescale(d('3'), 2))).toBe('3.00');
  });

  it('divides to a requested scale, rounding the last digit', () => {
    expect(formatDecimal(divide(d('10'), d('3'), 2)!)).toBe('3.33');
    expect(formatDecimal(divide(d('20'), d('3'), 2)!)).toBe('6.67');
    expect(formatDecimal(divide(d('-20'), d('3'), 2)!)).toBe('-6.67');
    expect(formatDecimal(divide(d('20'), d('-3'), 2)!)).toBe('-6.67');
    expect(formatDecimal(divide(d('1.5'), d('0.25'), 0)!)).toBe('6');
    expect(formatDecimal(divide(d('6'), d('2'), 0)!)).toBe('3');
  });

  it('has no value for a division by zero, rather than infinity', () => {
    expect(divide(d('1'), d('0.00'), 2)).toBeUndefined();
  });

  it('knows a whole number at any scale', () => {
    expect(isInteger(d('4.00'))).toBe(true);
    expect(isInteger(d('4.01'))).toBe(false);
  });

  const arbitraryDecimal = fc
    .tuple(fc.bigInt({ min: BigInt(-1e12), max: BigInt(1e12) }), fc.integer({ min: 0, max: 6 }))
    .map(([units, scale]): Decimal => ({ units, scale }));

  it('satisfies the laws a person doing sums relies on', () => {
    fc.assert(
      fc.property(arbitraryDecimal, arbitraryDecimal, arbitraryDecimal, (a, b, c) => {
        expect(compareDecimal(add(a, b), add(b, a))).toBe(0);
        expect(compareDecimal(add(add(a, b), c), add(a, add(b, c)))).toBe(0);
        expect(compareDecimal(subtract(add(a, b), b), a)).toBe(0);
        expect(compareDecimal(multiply(a, b), multiply(b, a))).toBe(0);
        expect(compareDecimal(multiply(a, add(b, c)), add(multiply(a, b), multiply(a, c)))).toBe(0);
      }),
    );
  });

  it('orders consistently: exactly one of a<b, a=b, a>b, and antisymmetric', () => {
    fc.assert(
      fc.property(arbitraryDecimal, arbitraryDecimal, (a, b) => {
        expect(compareDecimal(a, b)).toBe(-compareDecimal(b, a) || 0);
      }),
    );
  });

  it('rounds a quotient to within half a unit of the exact answer', () => {
    fc.assert(
      fc.property(
        arbitraryDecimal,
        arbitraryDecimal.filter((value) => value.units !== BigInt(0)),
        fc.integer({ min: 0, max: 6 }),
        (a, b, scale) => {
          const quotient = divide(a, b, scale)!;
          // |quotient * b - a| <= |b| / 2 units at the quotient's scale.
          const back = multiply(quotient, b);
          const error = subtract(back, a);
          const bound = multiply(
            { units: b.units < BigInt(0) ? -b.units : b.units, scale: b.scale },
            { units: BigInt(5), scale: scale + 1 },
          );
          const absoluteError = {
            units: error.units < BigInt(0) ? -error.units : error.units,
            scale: error.scale,
          };
          expect(compareDecimal(absoluteError, bound)).toBeLessThanOrEqual(0);
        },
      ),
    );
  });
});
