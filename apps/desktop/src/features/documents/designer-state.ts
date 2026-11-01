import type { Block, LeafBlock, TemplateDesign } from '@integr8/document-render';
import { blockSchema } from '@integr8/document-render';
import { readLocalCopy } from '../forms/model/recovery';

/**
 * The designer's editing state (1.3.0 decision 8): the template's design and
 * name with undo and redo, the local copy that survives a crash, and the
 * clipboard blocks are copied between a form's templates through.
 *
 * Typing in a box changes the design on every key; those changes join into
 * one step while they keep coming, so undo takes back a word or a sentence
 * rather than a letter. Adding, removing, moving, duplicating and pasting are
 * each a step of their own.
 */

export interface Draft {
  design: TemplateDesign;
  name: string;
}

export interface History {
  readonly present: Draft;
  readonly past: readonly Draft[];
  readonly future: readonly Draft[];
  /** When the last typed change arrived, to join the next one to it. */
  readonly typedAt: number | null;
}

const HISTORY_LIMIT = 100;
/** Typed changes this close together are one step. */
const TYPING_JOINS_MS = 1_000;

export type HistoryAction =
  | { type: 'load'; draft: Draft }
  | { type: 'edit'; draft: Draft; kind: 'typing' | 'step'; at: number }
  | { type: 'undo' }
  | { type: 'redo' };

export function initialHistory(draft: Draft): History {
  return { present: draft, past: [], future: [], typedAt: null };
}

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case 'load':
      return initialHistory(action.draft);
    case 'edit': {
      if (action.draft === state.present) {
        return state;
      }
      const joins =
        action.kind === 'typing' &&
        state.typedAt !== null &&
        action.at - state.typedAt < TYPING_JOINS_MS &&
        state.past.length > 0;
      return {
        present: action.draft,
        past: joins ? state.past : [...state.past, state.present].slice(-HISTORY_LIMIT),
        future: [],
        typedAt: action.kind === 'typing' ? action.at : null,
      };
    }
    case 'undo': {
      const previous = state.past.at(-1);
      if (previous === undefined) {
        return state;
      }
      return {
        present: previous,
        past: state.past.slice(0, -1),
        future: [state.present, ...state.future],
        typedAt: null,
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (next === undefined) {
        return state;
      }
      return {
        present: next,
        past: [...state.past, state.present],
        future: state.future.slice(1),
        typedAt: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Local recovery
// ---------------------------------------------------------------------------

/**
 * Where a template's unsaved work is kept on this device: per company and
 * template, like the form builder's draft, and removed once it is saved. The
 * copy uses the form builder's own format and helpers (`forms/model/recovery`).
 */
export function templateRecoveryKey(tenantId: string, templateId: string): string {
  return `integr8.pdfTemplateDraft.${tenantId}.${templateId}`;
}

export { readLocalCopy };

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

/**
 * Blocks copied for pasting into another template of the same form. Kept on
 * this device, per company and form: a block names the form's questions, so
 * it only makes sense in that form's templates.
 */
export function clipboardKey(tenantId: string, formId: string): string {
  return `integr8.pdfClipboard.${tenantId}.${formId}`;
}

export function readClipboard(key: string, formId: string): (Block | LeafBlock)[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return [];
    }
    const stored = JSON.parse(raw) as { formId?: unknown; blocks?: unknown };
    if (stored.formId !== formId || !Array.isArray(stored.blocks)) {
      return [];
    }
    // Checked block by block: whatever is on this device is read as untrusted.
    return stored.blocks.slice(0, 300).flatMap((block: unknown) => {
      const parsed = blockSchema.safeParse(block);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export function writeClipboard(
  key: string,
  formId: string,
  blocks: readonly (Block | LeafBlock)[],
) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ formId, copiedAt: new Date().toISOString(), blocks }),
    );
    // Other open designers of the same form learn of it.
    window.dispatchEvent(new CustomEvent(CLIPBOARD_EVENT, { detail: key }));
  } catch {
    // Storage full or switched off: copying is lost, nothing else.
  }
}

export const CLIPBOARD_EVENT = 'integr8:pdf-clipboard';
