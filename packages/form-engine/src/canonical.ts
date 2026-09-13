/**
 * Canonical JSON: one byte sequence per value.
 *
 * P06's first exit criterion is that the same definition and answers produce
 * *byte-identical* results in Node and in Hermes. `JSON.stringify` alone does
 * not promise that — object key order follows insertion order, and insertion
 * order depends on the path the engine took to build the object. So results are
 * compared, and golden files are written, in this form instead.
 *
 * Two deliberate restrictions:
 *
 * - **Keys are sorted by UTF-16 code unit**, with `<`, never `localeCompare`,
 *   whose ordering depends on the host's collation data.
 * - **Numbers must be safe integers.** Every engine prints an integer the same
 *   way. Doubles are where engines have historically disagreed on the last
 *   digit, so the engine never emits one: decimals travel as strings.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          `${path} is ${String(value)}; canonical JSON carries safe integers only`,
        );
      }
      // `-0` and `0` are the same answer and must be the same bytes.
      return value === 0 ? '0' : String(value);
    case 'object':
      return Array.isArray(value) ? encodeArray(value, path) : encodeObject(value, path);
    default:
      throw new CanonicalJsonError(`${path} is a ${typeof value}, which has no JSON form`);
  }
}

function encodeArray(values: readonly unknown[], path: string): string {
  const parts: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    parts.push(encode(values[index], `${path}[${String(index)}]`));
  }
  return `[${parts.join(',')}]`;
}

function encodeObject(value: object, path: string): string {
  const keys = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort(compareCodeUnits);

  const parts: string[] = [];
  for (const key of keys) {
    parts.push(
      `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], `${path}.${key}`)}`,
    );
  }
  return `{${parts.join(',')}}`;
}

/** Ordering by UTF-16 code unit. The same on every engine, unlike collation. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
