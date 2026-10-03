import { type EditError, type FormDefinition, isEditError } from '@integr8/form-engine';

/**
 * The builder's editing state: the definition, what is selected, and undo.
 *
 * A reducer over pure values. Every edit is one of the engine's authoring
 * operations, which return a new definition or an `EditError`, so undo is "put
 * the previous value back" and a refused edit leaves everything as it was and
 * says why.
 */

const HISTORY_LIMIT = 100;

export interface EditorState {
  readonly definition: FormDefinition;
  readonly selected: string | undefined;
  /**
   * Changes when a different element is selected, so panels holding half-edited
   * state start fresh — and stays put when the selected element is only renamed.
   */
  readonly selection: number;
  readonly past: readonly FormDefinition[];
  readonly future: readonly FormDefinition[];
  /** The last refused edit, until the next successful one. */
  readonly refused: EditError | undefined;
}

export type EditorAction =
  | { type: 'load'; definition: FormDefinition }
  | {
      type: 'edit';
      apply: (definition: FormDefinition) => FormDefinition | EditError;
      /** What to select afterwards. Omitted keeps the selection, if it still exists. */
      select?: string | undefined;
      /** The selected element was renamed, not replaced: keep the panel as it is. */
      renamed?: boolean;
    }
  | { type: 'select'; id: string | undefined }
  | { type: 'undo' }
  | { type: 'redo' };

export function initialEditor(definition: FormDefinition): EditorState {
  return {
    definition,
    selected: undefined,
    selection: 0,
    past: [],
    future: [],
    refused: undefined,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'load':
      return initialEditor(action.definition);

    case 'select':
      return {
        ...state,
        selected: action.id,
        selection: action.id === state.selected ? state.selection : state.selection + 1,
        refused: undefined,
      };

    case 'edit': {
      const result = action.apply(state.definition);
      if (isEditError(result)) {
        return { ...state, refused: result };
      }
      if (result === state.definition) {
        return state;
      }
      const wanted = 'select' in action ? action.select : state.selected;
      const selected = wanted !== undefined && exists(result, wanted) ? wanted : undefined;
      return {
        definition: result,
        selected,
        selection:
          selected === state.selected || action.renamed === true
            ? state.selection
            : state.selection + 1,
        past: [...state.past, state.definition].slice(-HISTORY_LIMIT),
        future: [],
        refused: undefined,
      };
    }

    case 'undo': {
      const previous = state.past.at(-1);
      if (previous === undefined) {
        return state;
      }
      return {
        definition: previous,
        selected: keepIfExists(previous, state.selected),
        selection: state.selection + 1,
        past: state.past.slice(0, -1),
        future: [state.definition, ...state.future],
        refused: undefined,
      };
    }

    case 'redo': {
      const next = state.future[0];
      if (next === undefined) {
        return state;
      }
      return {
        definition: next,
        selected: keepIfExists(next, state.selected),
        selection: state.selection + 1,
        past: [...state.past, state.definition],
        future: state.future.slice(1),
        refused: undefined,
      };
    }
  }
}

function exists(definition: FormDefinition, id: string): boolean {
  return definition.pages.some(
    (page) =>
      page.id === id ||
      page.sections.some(
        (section) => section.id === id || section.fields.some((field) => field.id === id),
      ),
  );
}

function keepIfExists(definition: FormDefinition, id: string | undefined): string | undefined {
  return id !== undefined && exists(definition, id) ? id : undefined;
}
