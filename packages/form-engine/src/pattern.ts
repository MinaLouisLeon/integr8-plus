/**
 * Patterns a company admin may put on a text field, and nothing more.
 *
 * A regular expression written by a customer is two risks at once.
 *
 * **It can hang the server.** `(a+)+$` against thirty `a`s and a `b` backtracks
 * for longer than the request is allowed to live, and the API revalidates every
 * submission (P08). One bad pattern published by one company would be a
 * denial-of-service against the shared API.
 *
 * **It can mean different things in different engines.** Lookbehind, named
 * groups, Unicode property escapes and the `u` and `v` flags have arrived in V8
 * and Hermes at different times and with different edge cases. A pattern that
 * matches on the phone and fails on the server rejects a valid submission.
 *
 * So patterns are parsed against a small grammar before a form can be
 * published, and anything outside it is refused with the position of the
 * problem:
 *
 * - literals, `.`, `^`, `$`
 * - `\d \D \w \W \s \S`, and escaped punctuation
 * - character classes, with ranges and negation
 * - groups, capturing or `(?:…)`
 * - `? * + {n} {n,} {n,m}`, greedy only
 * - `|`
 *
 * Refused outright: backreferences, lookaround, named groups, `\b`, `\u`, `\p`,
 * lazy quantifiers, and **any quantifier applied to a group that itself
 * contains a quantifier or an alternation** — the construction behind almost
 * every catastrophic-backtracking pattern.
 *
 * What survives can still backtrack polynomially: `\d*\d*\d*x` is legal
 * syntax. So every pattern also carries a *cost*: the product, over its
 * quantifiers, of how many repetitions each can make, with an unbounded one
 * counted as the longest value a pattern is ever run against. Past a budget,
 * the pattern is refused. And a pattern is never run against a value longer
 * than {@link PATTERN_MAX_INPUT}.
 *
 * Matching is whole-value — the source is wrapped in `^(?:…)$` — which is what
 * a person writing `[A-Z]{3}[0-9]{4}` for a serial number means.
 */

/** A value longer than this is reported as not matching, without running the pattern. */
export const PATTERN_MAX_INPUT = 256;

export const PATTERN_MAX_SOURCE = 200;

const MAX_REPEAT = 100;

/** Roughly a millisecond of backtracking in the worst case on a phone. */
const COST_BUDGET = 1_000_000;

export type PatternCheck =
  { ok: true; cost: number } | { ok: false; reason: string; index: number };

const SHORTHAND = new Set(['d', 'D', 'w', 'W', 's', 'S']);
const ESCAPABLE = new Set([...'.\\+*?()[]{}|^$/-']);
const SPECIAL = new Set([...'\\[](){}*+?|^$.']);

class PatternError extends Error {
  constructor(
    readonly reason: string,
    readonly index: number,
  ) {
    super(reason);
  }
}

interface Parsed {
  /** Whether this span contains a quantifier. */
  quantified: boolean;
  /** Whether this span contains an alternation. */
  alternates: boolean;
}

/**
 * Recursive descent over the grammar above. Only ever inspects the source; it
 * never builds or runs a `RegExp`, so a hostile pattern costs nothing to check.
 */
class Parser {
  #index = 0;
  #cost = 1;

  constructor(private readonly source: string) {}

  parse(): number {
    this.#alternation();
    if (this.#index < this.source.length) {
      // Only an unbalanced `)` stops the top-level alternation early.
      throw new PatternError('unmatched ")"', this.#index);
    }
    return this.#cost;
  }

  #peek(): string | undefined {
    return this.source[this.#index];
  }

  #alternation(): Parsed {
    const result = this.#sequence();
    while (this.#peek() === '|') {
      this.#index += 1;
      const next = this.#sequence();
      result.quantified ||= next.quantified;
      result.alternates = true;
    }
    return result;
  }

  #sequence(): Parsed {
    const result: Parsed = { quantified: false, alternates: false };

    for (;;) {
      const char = this.#peek();
      if (char === undefined || char === '|' || char === ')') {
        return result;
      }

      const start = this.#index;
      const atom = this.#atom();
      const repeat = this.#quantifier();

      if (repeat === undefined) {
        result.quantified ||= atom.quantified;
        result.alternates ||= atom.alternates;
        continue;
      }

      if (!atom.repeatable) {
        throw new PatternError('nothing to repeat', start);
      }
      if (atom.quantified || atom.alternates) {
        throw new PatternError(
          'a repeated group may not itself contain a repetition or an alternative',
          start,
        );
      }

      this.#cost *= repeat;
      if (this.#cost > COST_BUDGET) {
        throw new PatternError('too many open-ended repetitions', start);
      }
      result.quantified = true;
    }
  }

  #atom(): Parsed & { repeatable: boolean } {
    const start = this.#index;
    const char = this.#peek();

    switch (char) {
      case '^':
      case '$':
        this.#index += 1;
        return { quantified: false, alternates: false, repeatable: false };
      case '.':
        this.#index += 1;
        return { quantified: false, alternates: false, repeatable: true };
      case '\\':
        this.#escape(false);
        return { quantified: false, alternates: false, repeatable: true };
      case '[':
        this.#characterClass();
        return { quantified: false, alternates: false, repeatable: true };
      case '(': {
        this.#index += 1;
        if (this.#peek() === '?') {
          if (this.source.slice(this.#index, this.#index + 2) !== '?:') {
            throw new PatternError('lookaround and named groups are not supported', start);
          }
          this.#index += 2;
        }
        if (this.#peek() === ')') {
          throw new PatternError('empty group', start);
        }
        const inner = this.#alternation();
        if (this.#peek() !== ')') {
          throw new PatternError('unclosed group', start);
        }
        this.#index += 1;
        return { ...inner, repeatable: true };
      }
      case undefined:
        throw new PatternError('unexpected end of pattern', start);
      case '*':
      case '+':
      case '?':
        // A quantifier where an atom should be. "Escape it" would be the wrong
        // advice for `*abc`, where the person almost certainly meant `.*abc`.
        throw new PatternError('nothing to repeat', start);
      default:
        if (SPECIAL.has(char)) {
          throw new PatternError(`"${char}" must be escaped`, start);
        }
        this.#index += 1;
        return { quantified: false, alternates: false, repeatable: true };
    }
  }

  /** Returns how many repetitions the quantifier allows, plus one, or `undefined` if none. */
  #quantifier(): number | undefined {
    const start = this.#index;
    const char = this.#peek();
    let factor: number;

    switch (char) {
      case '?':
        this.#index += 1;
        factor = 2;
        break;
      case '*':
      case '+':
        this.#index += 1;
        factor = PATTERN_MAX_INPUT + 1;
        break;
      case '{': {
        const match = /^\{([0-9]{1,3})(,([0-9]{1,3})?)?\}/.exec(this.source.slice(this.#index));
        if (match === null) {
          throw new PatternError('"{" must be escaped or be a repetition like {2,5}', start);
        }
        const min = Number(match[1]);
        const max =
          match[2] === undefined ? min : match[3] === undefined ? undefined : Number(match[3]);
        if (min > MAX_REPEAT || (max !== undefined && max > MAX_REPEAT)) {
          throw new PatternError(`a repetition may not exceed ${String(MAX_REPEAT)}`, start);
        }
        if (max !== undefined && max < min) {
          throw new PatternError('a repetition range must be low to high', start);
        }
        this.#index += match[0].length;
        factor = (max ?? PATTERN_MAX_INPUT) + 1;
        break;
      }
      default:
        return undefined;
    }

    const next = this.#peek();
    if (next === '?') {
      throw new PatternError('lazy repetition is not supported', this.#index);
    }
    if (next === '*' || next === '+' || next === '{') {
      throw new PatternError('a repetition cannot itself be repeated', this.#index);
    }
    return factor;
  }

  #escape(inClass: boolean): void {
    const start = this.#index;
    const next = this.source[this.#index + 1];

    if (next === undefined) {
      throw new PatternError('a pattern cannot end with "\\"', start);
    }
    if (SHORTHAND.has(next) || ESCAPABLE.has(next)) {
      this.#index += 2;
      return;
    }
    if (/[0-9]/.test(next)) {
      throw new PatternError('backreferences are not supported', start);
    }
    throw new PatternError(
      `"\\${next}" is not supported${inClass ? ' in a character class' : ''}`,
      start,
    );
  }

  #characterClass(): void {
    const start = this.#index;
    this.#index += 1;
    if (this.#peek() === '^') {
      this.#index += 1;
    }

    let members = 0;
    for (;;) {
      const char = this.#peek();
      if (char === undefined) {
        throw new PatternError('unclosed character class', start);
      }
      if (char === ']') {
        if (members === 0) {
          throw new PatternError('empty character class', start);
        }
        this.#index += 1;
        return;
      }
      if (char === '[') {
        throw new PatternError('"[" must be escaped inside a character class', this.#index);
      }

      const lowStart = this.#index;
      let low: string | null;
      if (char === '\\') {
        // An escaped literal such as `\[` is one character and can start a
        // range: the engine reads `[\[--]` as the range `[` to `-`, which runs
        // backwards, so the checker has to read it the same way or it accepts
        // a pattern the engine then refuses to compile. A shorthand such as
        // `\d` is not a character and a `-` after it is a literal hyphen.
        const escaped = this.source[this.#index + 1];
        this.#escape(true);
        members += 1;
        low = escaped !== undefined && ESCAPABLE.has(escaped) ? escaped : null;
      } else {
        low = char;
        this.#index += 1;
        members += 1;
      }

      // A range: `a-z`. A trailing `-` before `]` is a literal hyphen.
      if (
        low !== null &&
        this.#peek() === '-' &&
        this.source[this.#index + 1] !== ']' &&
        this.source[this.#index + 1] !== undefined
      ) {
        const high = this.source[this.#index + 1] ?? '';
        if (high === '\\' || high === '[') {
          throw new PatternError('a range must run between two plain characters', this.#index);
        }
        if (high < low) {
          throw new PatternError(`the range "${low}-${high}" runs backwards`, lowStart);
        }
        this.#index += 2;
      }
    }
  }
}

export function checkPattern(source: string): PatternCheck {
  if (source.length === 0) {
    return { ok: false, reason: 'the pattern is empty', index: 0 };
  }
  if (source.length > PATTERN_MAX_SOURCE) {
    return {
      ok: false,
      reason: `a pattern may be at most ${String(PATTERN_MAX_SOURCE)} characters`,
      index: PATTERN_MAX_SOURCE,
    };
  }

  try {
    return { ok: true, cost: new Parser(source).parse() };
  } catch (error) {
    if (error instanceof PatternError) {
      return { ok: false, reason: error.reason, index: error.index };
    }
    throw error;
  }
}

const compiled = new Map<string, RegExp>();

/**
 * Whole-value match. Assumes the pattern already passed {@link checkPattern};
 * `compileDefinition` guarantees that for every pattern in a published form.
 */
export function matchesPattern(source: string, caseInsensitive: boolean, value: string): boolean {
  if (value.length > PATTERN_MAX_INPUT) {
    return false;
  }

  const key = `${caseInsensitive ? 'i' : '-'}${source}`;
  let regex = compiled.get(key);
  if (regex === undefined) {
    regex = new RegExp(`^(?:${source})$`, caseInsensitive ? 'i' : '');
    compiled.set(key, regex);
  }
  return regex.test(value);
}
