/**
 * Surgical edits to a JSON (or JSON-with-comments) settings file: set or
 * remove one property two levels down (`mcpServers` → `integr8-forms`) and
 * leave every other byte of the file as it was — other servers, the user's
 * comments, their indentation and line endings. AI tools' settings files are
 * hand-edited (VS Code's `mcp.json` is JSONC; Gemini's `settings.json` holds
 * everything), so reading, changing and re-serialising the whole file would
 * throw away what the user wrote.
 *
 * Only what these files need: objects, arrays, strings, numbers, true, false,
 * null, `//` and `/* *\/` comments and trailing commas.
 */

export class JsoncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsoncError';
  }
}

type TokenKind = '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'literal';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '﻿') {
      at += 1;
    } else if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      if (end === -1) {
        throw new JsoncError('A comment is never closed.');
      }
      at = end + 2;
    } else if ('{}[]:,'.includes(char)) {
      tokens.push({ kind: char as TokenKind, start: at, end: at + 1 });
      at += 1;
    } else if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      if (end >= text.length) {
        throw new JsoncError('A string is never closed.');
      }
      tokens.push({ kind: 'string', start: at, end: end + 1 });
      at = end + 1;
    } else if (/[-0-9a-z]/u.test(char)) {
      let end = at;
      while (end < text.length && /[-+.0-9a-zA-Z]/u.test(text[end] ?? '')) {
        end += 1;
      }
      tokens.push({ kind: 'literal', start: at, end });
      at = end;
    } else {
      throw new JsoncError(`Unexpected character "${char}" at ${String(at)}.`);
    }
  }
  return tokens;
}

interface Property {
  key: string;
  /** Where the key starts. */
  start: number;
  value: Node;
}

interface Node {
  kind: 'object' | 'array' | 'value';
  start: number;
  /** One past the last character. */
  end: number;
  properties: Property[];
}

class Parser {
  #at = 0;
  constructor(
    private readonly text: string,
    private readonly tokens: Token[],
  ) {}

  #next(): Token {
    const token = this.tokens[this.#at];
    if (token === undefined) {
      throw new JsoncError('The file ends too early.');
    }
    this.#at += 1;
    return token;
  }

  #peek(): Token | undefined {
    return this.tokens[this.#at];
  }

  parse(): Node {
    const node = this.#value();
    if (this.#peek() !== undefined) {
      throw new JsoncError('Something follows the end of the settings.');
    }
    return node;
  }

  #value(): Node {
    const token = this.#next();
    if (token.kind === '{') {
      return this.#object(token);
    }
    if (token.kind === '[') {
      let last = this.#peek();
      while (last !== undefined && last.kind !== ']') {
        this.#value();
        if (this.#peek()?.kind === ',') {
          this.#next();
        }
        last = this.#peek();
      }
      const close = this.#next();
      return { kind: 'array', start: token.start, end: close.end, properties: [] };
    }
    if (token.kind === 'string' || token.kind === 'literal') {
      return { kind: 'value', start: token.start, end: token.end, properties: [] };
    }
    throw new JsoncError(`Unexpected "${this.text.slice(token.start, token.end)}".`);
  }

  #object(open: Token): Node {
    const properties: Property[] = [];
    for (;;) {
      const token = this.#next();
      if (token.kind === '}') {
        return { kind: 'object', start: open.start, end: token.end, properties };
      }
      if (token.kind === ',') {
        continue;
      }
      if (token.kind !== 'string') {
        throw new JsoncError('An object key must be a string.');
      }
      if (this.#next().kind !== ':') {
        throw new JsoncError('A key must be followed by ":".');
      }
      const key = JSON.parse(this.text.slice(token.start, token.end)) as string;
      properties.push({ key, start: token.start, value: this.#value() });
    }
  }
}

function parseTree(text: string): Node | undefined {
  const tokens = tokenize(text);
  return tokens.length === 0 ? undefined : new Parser(text, tokens).parse();
}

/** The text with comments and trailing commas removed: plain JSON. */
function plain(text: string): string {
  const tokens = tokenize(text);
  return tokens
    .filter((token, index) => {
      const next = tokens[index + 1];
      return !(token.kind === ',' && (next?.kind === '}' || next?.kind === ']'));
    })
    .map((token) => text.slice(token.start, token.end))
    .join('');
}

/** Reads a JSON or JSONC file's content; an empty file is an empty object. */
export function parseJsonc(text: string): unknown {
  const json = plain(text);
  return json === '' ? {} : (JSON.parse(json) as unknown);
}

const lineEnding = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

/** The whitespace at the start of the line `index` is on. */
function indentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(lineStart))?.[0] ?? '';
}

/** The file's own indentation step, two spaces when it has none. */
function indentUnit(text: string): string {
  const match = /\n([ \t]+)\S/u.exec(text);
  return match?.[1] ?? '  ';
}

/** A value as JSON, its later lines indented to sit under `indent`. */
function render(value: unknown, unit: string, indent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
}

/** Inserts `"key": value` as the last property of `object`. */
function insertInto(
  text: string,
  object: Node,
  key: string,
  value: unknown,
  unit: string,
  eol: string,
): string {
  const last = object.properties[object.properties.length - 1];
  if (last === undefined) {
    const indent = indentAt(text, object.start) + unit;
    const closing = indentAt(text, object.start);
    const body = `${eol}${indent}${JSON.stringify(key)}: ${render(value, unit, indent, eol)}${eol}${closing}`;
    return `${text.slice(0, object.start + 1)}${body}${text.slice(object.end - 1)}`;
  }
  const indent = indentAt(text, last.start);
  // A trailing comma after the last property (JSONC) is reused.
  const after = text.slice(last.value.end, object.end - 1);
  const trailingComma = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*,/u.exec(after);
  const insertAt =
    trailingComma === null ? last.value.end : last.value.end + trailingComma[0].length;
  const prefix = trailingComma === null ? ',' : '';
  const addition = `${prefix}${eol}${indent}${JSON.stringify(key)}: ${render(value, unit, indent, eol)}${trailingComma === null ? '' : ','}`;
  return `${text.slice(0, insertAt)}${addition}${text.slice(insertAt)}`;
}

function rootObject(text: string): Node | undefined {
  const root = parseTree(text);
  if (root !== undefined && root.kind !== 'object') {
    throw new JsoncError('The settings file is not a JSON object.');
  }
  return root;
}

/** `section.name` as it is now, or undefined. */
export function getEntry(text: string, section: string, name: string): unknown {
  const parsed = parseJsonc(text);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const holder = (parsed as Record<string, unknown>)[section];
  if (typeof holder !== 'object' || holder === null) {
    return undefined;
  }
  return (holder as Record<string, unknown>)[name];
}

/** Sets `section.name` to `value`, touching nothing else in the file. */
export function setEntry(text: string, section: string, name: string, value: unknown): string {
  const eol = lineEnding(text);
  const unit = indentUnit(text);
  const root = rootObject(text);
  if (root === undefined) {
    return `${JSON.stringify({ [section]: { [name]: value } }, null, 2)
      .split('\n')
      .join(eol)}${eol}`;
  }
  const holder = root.properties.findLast((property) => property.key === section);
  if (holder === undefined) {
    return insertInto(text, root, section, { [name]: value }, unit, eol);
  }
  if (holder.value.kind !== 'object') {
    throw new JsoncError(
      `"${section}" in the settings file is not an object; it was left as it is.`,
    );
  }
  const existing = holder.value.properties.findLast((property) => property.key === name);
  if (existing === undefined) {
    return insertInto(text, holder.value, name, value, unit, eol);
  }
  const indent = indentAt(text, existing.start);
  return `${text.slice(0, existing.value.start)}${render(value, unit, indent, eol)}${text.slice(existing.value.end)}`;
}

/** Removes `section.name` (every copy), touching nothing else; the text unchanged when absent. */
export function removeEntry(text: string, section: string, name: string): string {
  let current = text;
  for (;;) {
    const root = rootObject(current);
    const holder = root?.properties.findLast((property) => property.key === section);
    if (holder?.value.kind !== 'object') {
      return current;
    }
    const properties = holder.value.properties;
    const index = properties.findIndex((property) => property.key === name);
    const target = properties[index];
    if (target === undefined) {
      return current;
    }
    const next = properties[index + 1];
    const previous = properties[index - 1];
    if (next !== undefined) {
      // Up to the next key: our property, its comma and the whitespace before the next.
      current = `${current.slice(0, target.start)}${current.slice(next.start)}`;
    } else if (previous !== undefined) {
      const trailing = tokenize(current.slice(target.value.end, holder.value.end - 1))[0];
      if (trailing?.kind === ',') {
        // A trailing comma after ours (JSONC): keep the separator after the
        // one before as its trailing comma, and remove ours with our entry.
        const separator = tokenize(current.slice(previous.value.end, target.start))[0];
        const from = previous.value.end + (separator?.end ?? 0);
        current = `${current.slice(0, from)}${current.slice(target.value.end + trailing.end)}`;
      } else {
        // The last one: from the end of the one before, the separator with it.
        current = `${current.slice(0, previous.value.end)}${current.slice(target.value.end)}`;
      }
    } else {
      current = `${current.slice(0, holder.value.start + 1)}${current.slice(holder.value.end - 1)}`;
    }
  }
}
