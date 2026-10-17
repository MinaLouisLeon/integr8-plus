/**
 * JSON that keeps its text.
 *
 * An ETA document is signed over a serialisation of the values *as they were
 * written* (docs/e-invoicing PLAN §6 `canonical`). Parsing into JavaScript
 * would turn `1.10` into `1.1` and `100.00000` into `100`, and reorder nothing
 * only by luck. So documents live in this model from the moment they are built
 * to the moment they are sent: numbers are their lexemes, strings are their
 * escaped source text, objects keep their properties in order.
 */

export type JsonText =
  | {
      readonly kind: 'string';
      /** The escaped text between the quotes, as written. */ readonly raw: string;
    }
  | { readonly kind: 'number'; /** The lexeme, as written. */ readonly raw: string }
  | { readonly kind: 'literal'; readonly raw: 'true' | 'false' | 'null' }
  | { readonly kind: 'object'; readonly entries: readonly JsonEntry[] }
  | { readonly kind: 'array'; readonly items: readonly JsonText[] };

export interface JsonEntry {
  /** The decoded property name. */
  readonly name: string;
  readonly value: JsonText;
}

export class JsonTextError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${String(offset)}`);
    this.name = 'JsonTextError';
  }
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** A string value, escaped the way `JSON.stringify` escapes it. */
export function str(value: string): JsonText {
  return { kind: 'string', raw: JSON.stringify(value).slice(1, -1) };
}

/** A number from its lexeme. Refuses anything that is not a JSON number. */
export function num(lexeme: string): JsonText {
  if (!NUMBER.test(lexeme)) {
    throw new TypeError(`Not a JSON number: ${lexeme}`);
  }
  return { kind: 'number', raw: lexeme };
}

/** An object from `[name, value]` pairs, in this order; `undefined` values are left out. */
export function obj(pairs: readonly (readonly [string, JsonText | undefined])[]): JsonText {
  const seen = new Set<string>();
  const entries: JsonEntry[] = [];
  for (const [name, value] of pairs) {
    if (value === undefined) {
      continue;
    }
    if (seen.has(name)) {
      throw new TypeError(`Duplicate property: ${name}`);
    }
    seen.add(name);
    entries.push({ name, value });
  }
  return { kind: 'object', entries };
}

export function arr(items: readonly JsonText[]): JsonText {
  return { kind: 'array', items };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Parses strict JSON (RFC 8259) without losing a character of any value. A leading BOM is allowed. */
export function parseJsonText(text: string): JsonText {
  const reader = new Reader(text.startsWith('\uFEFF') ? text.slice(1) : text);
  reader.space();
  const value = reader.value(0);
  reader.space();
  if (!reader.done()) {
    throw new JsonTextError('Unexpected text after the value', reader.at);
  }
  return value;
}

const MAX_DEPTH = 64;

class Reader {
  at = 0;
  constructor(private readonly text: string) {}

  done(): boolean {
    return this.at >= this.text.length;
  }

  space(): void {
    while (!this.done() && ' \t\n\r'.includes(this.text[this.at] ?? '')) {
      this.at += 1;
    }
  }

  value(depth: number): JsonText {
    if (depth > MAX_DEPTH) {
      throw new JsonTextError('Nested too deeply', this.at);
    }
    const c = this.text[this.at];
    if (c === '{') {
      return this.object(depth);
    }
    if (c === '[') {
      return this.array(depth);
    }
    if (c === '"') {
      return { kind: 'string', raw: this.stringRaw() };
    }
    for (const literal of ['true', 'false', 'null'] as const) {
      if (this.text.startsWith(literal, this.at)) {
        this.at += literal.length;
        return { kind: 'literal', raw: literal };
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.text.slice(this.at));
    if (match !== null && match[0] !== '' && match[0] !== '-') {
      this.at += match[0].length;
      return { kind: 'number', raw: match[0] };
    }
    throw new JsonTextError('Expected a value', this.at);
  }

  object(depth: number): JsonText {
    this.at += 1;
    const entries: JsonEntry[] = [];
    const seen = new Set<string>();
    this.space();
    if (this.text[this.at] === '}') {
      this.at += 1;
      return { kind: 'object', entries };
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') {
        throw new JsonTextError('Expected a property name', this.at);
      }
      const nameAt = this.at;
      const name = JSON.parse(`"${this.stringRaw()}"`) as string;
      if (seen.has(name)) {
        throw new JsonTextError(`Duplicate property "${name}"`, nameAt);
      }
      seen.add(name);
      this.space();
      this.expect(':');
      this.space();
      entries.push({ name, value: this.value(depth + 1) });
      this.space();
      if (this.text[this.at] === ',') {
        this.at += 1;
        continue;
      }
      this.expect('}');
      return { kind: 'object', entries };
    }
  }

  array(depth: number): JsonText {
    this.at += 1;
    const items: JsonText[] = [];
    this.space();
    if (this.text[this.at] === ']') {
      this.at += 1;
      return { kind: 'array', items };
    }
    for (;;) {
      this.space();
      items.push(this.value(depth + 1));
      this.space();
      if (this.text[this.at] === ',') {
        this.at += 1;
        continue;
      }
      this.expect(']');
      return { kind: 'array', items };
    }
  }

  /** Reads a string and returns its source text between the quotes, checking every escape. */
  stringRaw(): string {
    const start = this.at + 1;
    let i = start;
    for (;;) {
      const c = this.text.charCodeAt(i);
      if (Number.isNaN(c)) {
        throw new JsonTextError('Unterminated string', this.at);
      }
      if (c === 0x22) {
        break;
      }
      if (c < 0x20) {
        throw new JsonTextError('Control character in a string', i);
      }
      if (c === 0x5c) {
        const next = this.text[i + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.text.slice(i + 2, i + 6))) {
            throw new JsonTextError('Bad \\u escape', i);
          }
          i += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) {
          throw new JsonTextError('Bad escape', i);
        }
        i += 2;
        continue;
      }
      i += 1;
    }
    this.at = i + 1;
    return this.text.slice(start, i);
  }

  expect(c: string): void {
    if (this.text[this.at] !== c) {
      throw new JsonTextError(`Expected "${c}"`, this.at);
    }
    this.at += 1;
  }
}

// ---------------------------------------------------------------------------
// Writing and reading values back
// ---------------------------------------------------------------------------

/** Compact JSON, with every value exactly as held. */
export function writeJsonText(value: JsonText): string {
  switch (value.kind) {
    case 'string':
      return `"${value.raw}"`;
    case 'number':
    case 'literal':
      return value.raw;
    case 'array':
      return `[${value.items.map(writeJsonText).join(',')}]`;
    case 'object':
      return `{${value.entries
        .map((entry) => `${JSON.stringify(entry.name)}:${writeJsonText(entry.value)}`)
        .join(',')}}`;
  }
}

/** The decoded text of a string value. */
export function stringValue(value: JsonText | undefined): string | undefined {
  return value?.kind === 'string' ? (JSON.parse(`"${value.raw}"`) as string) : undefined;
}

/** A property of an object, or undefined. */
export function property(value: JsonText | undefined, name: string): JsonText | undefined {
  return value?.kind === 'object'
    ? value.entries.find((entry) => entry.name === name)?.value
    : undefined;
}

/** The same object with one property replaced or added at the end. */
export function withProperty(value: JsonText, name: string, next: JsonText): JsonText {
  if (value.kind !== 'object') {
    throw new TypeError('Not an object');
  }
  const exists = value.entries.some((entry) => entry.name === name);
  return {
    kind: 'object',
    entries: exists
      ? value.entries.map((entry) => (entry.name === name ? { name, value: next } : entry))
      : [...value.entries, { name, value: next }],
  };
}

/** The same object without one property. */
export function withoutProperty(value: JsonText, name: string): JsonText {
  if (value.kind !== 'object') {
    throw new TypeError('Not an object');
  }
  return { kind: 'object', entries: value.entries.filter((entry) => entry.name !== name) };
}
