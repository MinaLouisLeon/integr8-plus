import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  formatDecimal,
  fractionFromBasisPoints,
  mul,
  parseDecimal,
  percentFromBasisPoints,
  round,
  sub,
  sum,
} from './decimal.js';

const d = parseDecimal;
const f = (value: ReturnType<typeof parseDecimal>, scale?: number) => formatDecimal(value, scale);

describe('exact decimals', () => {
  it('adds, subtracts and multiplies without floating point', () => {
    expect(f(add(d('0.1'), d('0.2')))).toBe('0.3');
    expect(f(sub(d('1'), d('0.00001')))).toBe('0.99999');
    expect(f(mul(d('1.1'), d('1.1')))).toBe('1.21');
    expect(f(sum([d('19.99'), d('0.01'), d('80')]))).toBe('100');
    expect(f(mul(d('123456789.1234'), d('1000')))).toBe('123456789123.4');
  });

  it('rounds half away from zero to five places', () => {
    expect(f(round(d('1.000005')))).toBe('1.00001');
    expect(f(round(d('1.000004999')))).toBe('1');
    expect(f(round(d('-1.000005')))).toBe('-1.00001');
    expect(f(round(d('2.5'), 0), 0)).toBe('3');
    expect(f(round(d('-2.5'), 0), 0)).toBe('-3');
  });

  it('writes the shortest lexeme, never -0', () => {
    expect(f(d('100.00000'))).toBe('100');
    expect(f(d('0.50'))).toBe('0.5');
    expect(f(d('-0.000001'))).toBe('0');
    expect(f(d('0'))).toBe('0');
  });

  it('turns basis points into rates', () => {
    expect(f(percentFromBasisPoints(1400))).toBe('14');
    expect(f(percentFromBasisPoints(1250))).toBe('12.5');
    expect(f(mul(d('200'), fractionFromBasisPoints(1400)))).toBe('28');
    expect(() => percentFromBasisPoints(-1)).toThrow(RangeError);
  });

  it('compares across scales and refuses what is not a decimal', () => {
    expect(compare(d('1.0'), d('1'))).toBe(0);
    expect(compare(d('1.00001'), d('1'))).toBe(1);
    expect(() => d('1e3')).toThrow(TypeError);
    expect(() => d('abc')).toThrow(TypeError);
  });
});
