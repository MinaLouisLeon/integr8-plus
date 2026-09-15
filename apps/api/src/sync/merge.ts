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

// ---------------------------------------------------------------------------
// Answers, with the entries of repeatable sections (P13b)
// ---------------------------------------------------------------------------

interface Entry {
  id: string;
  values: Record<string, unknown>;
}

/** A list of `{ id, values }`: how a repeatable section's answer is stored. */
function isEntryList(value: unknown): value is Entry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { values?: unknown }).values === 'object' &&
        (item as { values?: unknown }).values !== null &&
        !Array.isArray((item as { values?: unknown }).values),
    )
  );
}

const ids = (entries: readonly Entry[]) => entries.map((entry) => entry.id);

/**
 * Merges three versions of a section's entries, entry by entry and answer by
 * answer: two phones adding different appliances, or changing different
 * appliances, both keep their work. Undefined means only a person can decide —
 * the same answer changed differently, or an entry removed on one side and
 * changed on the other.
 */
function mergeEntries(base: Entry[], mine: Entry[], theirs: Entry[]): Entry[] | undefined {
  const find = (list: readonly Entry[], id: string) => list.find((entry) => entry.id === id);
  const merged = new Map<string, Entry>();
  const every = [...new Set([...ids(theirs), ...ids(mine), ...ids(base)])];

  for (const id of every) {
    const was = find(base, id);
    const now = find(mine, id);
    const other = find(theirs, id);
    if (now === undefined && other === undefined) {
      continue;
    }
    if (now === undefined || other === undefined) {
      const kept = now ?? other!;
      if (was === undefined) {
        merged.set(id, kept); // Added on one side only.
        continue;
      }
      // Removed on one side: fine unless the other side changed it meanwhile.
      if (!sameValue(kept.values, was.values)) {
        return undefined;
      }
      continue;
    }
    const values = mergeRecords(was?.values ?? {}, now.values, other.values);
    if (values.outcome === 'conflict') {
      return undefined;
    }
    merged.set(id, { id, values: values.value });
  }

  // Their order, unless only I reordered; entries I added go after the entry
  // they followed on my phone.
  const common = (list: readonly Entry[]) =>
    ids(list).filter((id) => merged.has(id) && find(base, id) !== undefined);
  const order =
    sameValue(common(theirs), common(base)) && !sameValue(common(mine), common(base))
      ? ids(mine).filter((id) => merged.has(id))
      : ids(theirs).filter((id) => merged.has(id));
  for (const id of ids(mine)) {
    if (!merged.has(id) || order.includes(id)) {
      continue;
    }
    const before = ids(mine)
      .slice(0, ids(mine).indexOf(id))
      .reverse()
      .find((candidate) => order.includes(candidate));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  }
  for (const id of merged.keys()) {
    if (!order.includes(id)) {
      order.push(id);
    }
  }
  return order.map((id) => merged.get(id)!);
}

/**
 * `mergeRecords` for a submission's answers: a repeatable section is merged
 * entry by entry rather than as one answer, and conflicts only when an entry's
 * answer was changed both ways, or an entry removed on one side was changed on
 * the other — reported, as any conflict is, on the section's key.
 */
export function mergeAnswers(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): MergeResult<Record<string, unknown>> {
  const listed = (value: unknown) => value === undefined || value === null || isEntryList(value);
  const isSection = (key: string) =>
    [base[key], mine[key], theirs[key]].some((value) => isEntryList(value) && value.length > 0) &&
    listed(base[key]) &&
    listed(mine[key]) &&
    listed(theirs[key]);

  const plain: string[] = [];
  const merged: Record<string, unknown> = { ...theirs };
  const conflicts: MergeConflict[] = [];
  let changed = false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    if (!isSection(key)) {
      plain.push(key);
      continue;
    }
    const entries = mergeEntries(
      (base[key] as Entry[] | undefined) ?? [],
      (mine[key] as Entry[] | undefined) ?? [],
      (theirs[key] as Entry[] | undefined) ?? [],
    );
    if (entries === undefined) {
      conflicts.push({
        key,
        base: base[key] ?? null,
        mine: mine[key] ?? null,
        theirs: theirs[key] ?? null,
      });
      continue;
    }
    if (!sameValue(entries.length === 0 ? undefined : entries, theirs[key])) {
      changed = true;
    }
    if (entries.length === 0) {
      delete merged[key];
    } else {
      merged[key] = entries;
    }
  }

  const pick = (record: Record<string, unknown>) =>
    Object.fromEntries(plain.filter((key) => key in record).map((key) => [key, record[key]]));
  const rest = mergeRecords(pick(base), pick(mine), pick(theirs));
  if (rest.outcome === 'conflict' || conflicts.length > 0) {
    return {
      outcome: 'conflict',
      conflicts: [...(rest.outcome === 'conflict' ? rest.conflicts : []), ...conflicts],
    };
  }
  for (const key of plain) {
    if (key in rest.value) {
      merged[key] = rest.value[key];
    } else {
      delete merged[key];
    }
  }
  return { outcome: 'merged', value: merged, changed: changed || rest.changed };
}
