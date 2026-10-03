import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkPattern, matchesPattern, PATTERN_MAX_INPUT, PATTERN_MAX_SOURCE } from './pattern.js';

describe('patterns a company admin would actually write', () => {
  it.each([
    ['[A-Z]{3}[0-9]{4}', 'ABC1234', 'AB1234'],
    ['\\d{3}-\\d{3}-\\d{4}', '555-123-4567', '5551234567'],
    ['[^@\\s]+@[^@\\s]+\\.[a-z]{2,6}', 'dana@northwind.io', 'dana@@northwind'],
    ['(?:SN|PN)-\\d+', 'SN-0042', 'XN-0042'],
    ['[0-9a-f]{8}', 'deadbeef', 'DEADBEEF'],
    ['GB\\d{2}|IE\\d{2}', 'IE12', 'FR12'],
    ['[a-z-]+', 'north-wind', 'North'],
    ['[-a-z]+', '-a', '1'],
    ['[\\--9]+', '-.9', 'a'],
    ['\\(\\d{2}\\) \\d{4}', '(02) 1234', '02 1234'],
    ['(ab)?c', 'abc', 'bc'],
    ['.{2,5}', 'abc', 'a'],
  ])('%s accepts %j and refuses %j', (source, matching, failing) => {
    expect(checkPattern(source).ok).toBe(true);
    expect(matchesPattern(source, false, matching)).toBe(true);
    expect(matchesPattern(source, false, failing)).toBe(false);
  });

  it('matches the whole value, not a substring of it', () => {
    expect(matchesPattern('\\d{4}', false, 'SN-1234-X')).toBe(false);
  });

  it('can ignore case when asked', () => {
    expect(matchesPattern('[0-9a-f]{8}', true, 'DEADBEEF')).toBe(true);
  });

  it('does not run against a value longer than the input limit', () => {
    expect(matchesPattern('.*', false, 'x'.repeat(PATTERN_MAX_INPUT))).toBe(true);
    expect(matchesPattern('.*', false, 'x'.repeat(PATTERN_MAX_INPUT + 1))).toBe(false);
  });
});

describe('patterns that could hang the server', () => {
  it.each(['(a+)+$', '(a*)*b', '(a|a)*', '(a|b)+', '(\\d+\\.)+\\d', '(?:x+x+)+y', '((ab)*)+'])(
    'refuses %s',
    (source) => {
      const result = checkPattern(source);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/repeated group/u);
    },
  );

  it('refuses too many open-ended repetitions in one pattern', () => {
    expect(checkPattern('\\d*\\d*x').ok).toBe(true);
    expect(checkPattern('\\d*\\d*\\d*x')).toMatchObject({
      ok: false,
      reason: 'too many open-ended repetitions',
    });
  });

  it('keeps the worst accepted pattern fast, against the worst input it can be given', () => {
    // Two adjacent open-ended repetitions over the same characters, then a
    // character that makes every attempt fail — the most backtracking the cost
    // budget permits.
    const source = '\\d*\\d*x';
    expect(checkPattern(source).ok).toBe(true);

    const started = performance.now();
    expect(matchesPattern(source, false, '1'.repeat(PATTERN_MAX_INPUT))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('syntax that means different things in different engines', () => {
  it.each([
    ['(?<=a)b', /lookaround/u],
    ['(?=a)a', /lookaround/u],
    ['(?<name>a)', /lookaround and named groups/u],
    ['(a)\\1', /backreferences/u],
    ['\\bword\\b', /"\\b" is not supported/u],
    ['\\u0041', /"\\u" is not supported/u],
    ['\\p{L}', /"\\p" is not supported/u],
    ['[\\u0041]', /in a character class/u],
    ['a+?', /lazy/u],
    ['a**', /cannot itself be repeated/u],
    ['a{2}+', /cannot itself be repeated/u],
  ])('refuses %s', (source, reason) => {
    const result = checkPattern(source);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(reason);
  });
});

describe('malformed patterns, reported with a position', () => {
  it.each([
    ['', 'the pattern is empty', 0],
    ['abc)', 'unmatched ")"', 3],
    ['(abc', 'unclosed group', 0],
    ['()', 'empty group', 0],
    ['[abc', 'unclosed character class', 0],
    ['[]', 'empty character class', 0],
    ['[^]', 'empty character class', 0],
    ['a{', '"{" must be escaped or be a repetition like {2,5}', 1],
    ['a{5,2}', 'a repetition range must be low to high', 1],
    ['a{101}', 'a repetition may not exceed 100', 1],
    ['*a', 'nothing to repeat', 0],
    ['^*', 'nothing to repeat', 0],
    ['a]', '"]" must be escaped', 1],
    ['a}', '"}" must be escaped', 1],
    ['abc\\', 'a pattern cannot end with "\\"', 3],
    ['[z-a]', 'the range "z-a" runs backwards', 1],
    ['[a-\\d]', 'a range must run between two plain characters', 2],
    ['[a[b]', '"[" must be escaped inside a character class', 2],
    // An escaped literal starts a range just as a plain character does; the
    // engine refuses this one as out of order, so the checker must too.
    ['[\\[--]', 'the range "[--" runs backwards', 1],
  ])('%j: %s at %i', (source, reason, index) => {
    expect(checkPattern(source)).toEqual({ ok: false, reason, index });
  });

  it('refuses a pattern longer than the limit', () => {
    expect(checkPattern('a'.repeat(PATTERN_MAX_SOURCE + 1))).toMatchObject({
      ok: false,
      index: PATTERN_MAX_SOURCE,
    });
  });
});

describe('the checker and the regular expression engine agree', () => {
  it('never accepts a pattern that the engine itself cannot compile', () => {
    const alphabet = fc.constantFrom(...'ab01.^$|()[]{}*+?\\-:dws,2'.split(''));
    fc.assert(
      fc.property(
        fc.array(alphabet, { maxLength: 24 }).map((chars) => chars.join('')),
        (source) => {
          if (checkPattern(source).ok) {
            expect(() => new RegExp(`^(?:${source})$`)).not.toThrow();
          }
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it('never accepts a pattern with a repeated group containing a repetition', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('a', '\\d', '[ab]', '.'),
        fc.constantFrom('*', '+', '{1,3}', '?'),
        fc.constantFrom('*', '+', '{2,}'),
        (atom, inner, outer) => {
          expect(checkPattern(`(${atom}${inner})${outer}`).ok).toBe(false);
        },
      ),
    );
  });
});
