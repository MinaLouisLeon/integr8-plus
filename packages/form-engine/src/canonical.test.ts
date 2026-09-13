import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, compareCodeUnits } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth, whatever order they were inserted in', () => {
    const one = { b: 1, a: { d: [2, { z: true, y: null }], c: 'x' } };
    const two = { a: { c: 'x', d: [2, { y: null, z: true }] }, b: 1 };

    expect(canonicalJson(one)).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson(two)).toBe(canonicalJson(one));
  });

  it('keeps array order, because order in an array is data', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('omits undefined properties, as JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('prints negative zero as zero', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('refuses a number that is not a safe integer, naming where it is', () => {
    expect(() => canonicalJson({ reading: { value: 0.1 } })).toThrow(/\$\.reading\.value is 0\.1/u);
    expect(() => canonicalJson([Number.MAX_SAFE_INTEGER + 1])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
  });

  it('refuses values with no JSON form', () => {
    expect(() => canonicalJson(() => 1)).toThrow(/function/u);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/u);
    expect(() => canonicalJson(BigInt(1))).toThrow(/bigint/u);
  });

  it('escapes strings exactly as JSON does, including Arabic and control characters', () => {
    expect(canonicalJson('صمام\n"a"')).toBe(JSON.stringify('صمام\n"a"'));
  });

  it('is a stable function of the value: shuffling keys never changes the bytes', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())),
        (record) => {
          const reversed = Object.fromEntries(Object.entries(record).reverse());
          expect(canonicalJson(reversed)).toBe(canonicalJson(record));
          expect(JSON.parse(canonicalJson(record))).toEqual(record);
        },
      ),
    );
  });
});

describe('compareCodeUnits', () => {
  it('orders by code unit, so uppercase sorts before lowercase everywhere', () => {
    expect(['b', 'B', 'a'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
    expect(compareCodeUnits('same', 'same')).toBe(0);
  });
});
