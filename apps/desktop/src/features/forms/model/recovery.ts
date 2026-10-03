import { canonicalJson } from '@integr8/form-engine';

/**
 * Crash recovery for the draft.
 *
 * Autosave reaches the server a second or so after an edit. Whatever happens in
 * that second — the window closes, the laptop sleeps, the network drops for an
 * afternoon — the edit is also written here first, on this device, and removed
 * once the server has it.
 *
 * `localStorage`, which this app otherwise keeps for display preferences only:
 * a draft form definition is something the person can already see and is
 * editing, not a credential, and it is cleared the moment it is saved. It is
 * keyed by company as well as form, so a shared machine does not offer one
 * company's unsaved edits to another.
 */

const PREFIX = 'integr8.formDraft';

export interface LocalCopy {
  /** The server revision these edits were made on top of. */
  baseRevision: number | null;
  definition: Record<string, unknown>;
  savedAt: string;
}

export type Recovery =
  | { kind: 'none' }
  /** Unsaved edits made on the draft the server still has. Safe to restore. */
  | { kind: 'restore'; copy: LocalCopy }
  /** Unsaved edits made on an older draft; somebody saved since. Restoring overwrites their work. */
  | { kind: 'stale'; copy: LocalCopy };

export function recoveryKey(tenantId: string, formId: string): string {
  return `${PREFIX}.${tenantId}.${formId}`;
}

/**
 * What to offer when the builder opens.
 *
 * Nothing, when there is no local copy or it matches the server's draft
 * exactly — the save simply landed before the local copy could be cleared.
 */
export function recoveryFor(
  copy: LocalCopy | undefined,
  server: { revision: number; definition: Record<string, unknown> } | undefined,
): Recovery {
  if (copy === undefined) {
    return { kind: 'none' };
  }
  if (server !== undefined && sameDefinition(copy.definition, server.definition)) {
    return { kind: 'none' };
  }
  const base = server?.revision ?? null;
  return copy.baseRevision === base ? { kind: 'restore', copy } : { kind: 'stale', copy };
}

export function sameDefinition(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

export function parseLocalCopy(raw: string | null | undefined): LocalCopy | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LocalCopy>;
    if (
      typeof parsed.definition !== 'object' ||
      parsed.definition === null ||
      typeof parsed.savedAt !== 'string' ||
      !(parsed.baseRevision === null || typeof parsed.baseRevision === 'number')
    ) {
      return undefined;
    }
    return {
      baseRevision: parsed.baseRevision,
      definition: parsed.definition,
      savedAt: parsed.savedAt,
    };
  } catch {
    return undefined;
  }
}

export function readLocalCopy(key: string): LocalCopy | undefined {
  try {
    return parseLocalCopy(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}

export function writeLocalCopy(key: string, copy: LocalCopy): void {
  try {
    localStorage.setItem(key, JSON.stringify(copy));
  } catch {
    // Storage full or disabled. Autosave still runs; only crash recovery is lost.
  }
}

export function clearLocalCopy(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // As above.
  }
}
