/**
 * Three-way merges for work done offline (P12).
 *
 * A phone sends what it changed (`mine`) and what it saw before changing it
 * (`base`). The server compares both with what it holds now (`theirs`):
 *
 * - a key only the phone changed takes the phone's value;
 * - a key only someone else changed keeps theirs;
 * - a key both changed to the same value is simply agreed;
 * - a key both changed to different values is a **conflict**, and nothing is
 *   written until a person decides.
 *
 * Nothing is ever resolved by whose clock says later.
 */

export interface MergeConflict<K extends string = string> {
  key: K;
  base: unknown;
  mine: unknown;
  theirs: unknown;
}

export type MergeResult<T extends Record<string, unknown>> =
  | { outcome: 'merged'; value: T; changed: boolean }
  | { outcome: 'conflict'; conflicts: MergeConflict<Extract<keyof T, string>>[] };

/** Deep equality for JSON values; key order does not matter. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a === null || b === null) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => sameValue(left[key], right[key]));
}

/**
 * Merges `mine` into `theirs`, key by key, relative to `base`. A key absent from
 * an object is the same as `null` or `undefined` in it, so a cleared answer and a
 * never-given one agree.
 */
export function mergeRecords<T extends Record<string, unknown>>(
  base: Partial<T>,
  mine: Partial<T>,
  theirs: Partial<T>,
): MergeResult<T> {
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  const merged: Record<string, unknown> = { ...theirs };
  const conflicts: MergeConflict<Extract<keyof T, string>>[] = [];
  let changed = false;

  for (const key of keys) {
    const mineChanged = !sameValue(mine[key], base[key]);
    if (!mineChanged) {
      continue;
    }
    const theirsChanged = !sameValue(theirs[key], base[key]);
    if (theirsChanged && !sameValue(theirs[key], mine[key])) {
      conflicts.push({
        key: key as Extract<keyof T, string>,
        base: base[key] ?? null,
        mine: mine[key] ?? null,
        theirs: theirs[key] ?? null,
      });
      continue;
    }
    if (!sameValue(theirs[key], mine[key])) {
      changed = true;
    }
    if (mine[key] === undefined || mine[key] === null) {
      delete merged[key];
    } else {
      merged[key] = mine[key];
    }
  }

  return conflicts.length > 0
    ? { outcome: 'conflict', conflicts }
    : { outcome: 'merged', value: merged as T, changed };
}
