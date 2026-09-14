import {
  addField,
  compileDefinition,
  emptyDefinition,
  evaluateForm,
  type Expression,
  type FormDefinition,
  newField,
  remove,
  updateField,
} from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { fromCalculation, toCalculation } from './calculation';
import { editorReducer, initialEditor } from './editor';
import { parseLocalCopy, recoveryFor } from './recovery';
import { issueElement } from './issues';
import { keyFromWording } from './rename';
import { say, withText } from './text';

const base = (): FormDefinition => emptyDefinition({ en: 'Inspection' });

const withField = (definition: FormDefinition, id: string) => {
  const result = addField(definition, 'section_1', newField('text', id, { en: id }));
  if ('error' in result) {
    throw new Error('setup');
  }
  return result;
};

describe('the editor', () => {
  it('applies an edit, selects what it names, and can undo and redo it', () => {
    let state = initialEditor(base());
    state = editorReducer(state, {
      type: 'edit',
      apply: (definition) => withField(definition, 'serial'),
      select: 'serial',
    });
    expect(state.selected).toBe('serial');
    expect(state.definition.pages[0]?.sections[0]?.fields).toHaveLength(1);

    state = editorReducer(state, { type: 'undo' });
    expect(state.definition.pages[0]?.sections[0]?.fields).toHaveLength(0);
    expect(state.selected).toBeUndefined();

    state = editorReducer(state, { type: 'redo' });
    expect(state.definition.pages[0]?.sections[0]?.fields).toHaveLength(1);
  });

  it('keeps everything as it was when the engine refuses an edit, and says why', () => {
    const before = initialEditor(base());
    const after = editorReducer(before, {
      type: 'edit',
      apply: (definition) => remove(definition, 'page_1'),
    });
    expect(after.definition).toBe(before.definition);
    expect(after.refused).toEqual({ error: 'last_page' });
    expect(after.past).toHaveLength(0);
  });

  it('drops the redo stack on a new edit, and forgets a selection that was deleted', () => {
    let state = initialEditor(withField(base(), 'a'));
    state = editorReducer(state, { type: 'select', id: 'a' });
    state = editorReducer(state, {
      type: 'edit',
      apply: (definition) => withField(definition, 'b'),
    });
    state = editorReducer(state, { type: 'undo' });
    expect(state.future).toHaveLength(1);

    state = editorReducer(state, { type: 'edit', apply: (definition) => remove(definition, 'a') });
    expect(state.future).toHaveLength(0);
    expect(state.selected).toBeUndefined();
  });

  it('bounds history, so a long session does not grow without limit', () => {
    let state = initialEditor(base());
    for (let index = 0; index < 150; index += 1) {
      state = editorReducer(state, {
        type: 'edit',
        apply: (definition) => withField(definition, `f_${String(index)}`),
      });
    }
    expect(state.past).toHaveLength(100);
  });
});

describe('crash recovery', () => {
  const server = { revision: 4, definition: base() as unknown as Record<string, unknown> };
  const edited = withField(base(), 'late') as unknown as Record<string, unknown>;

  it('offers nothing when there is no local copy, or it matches what the server has', () => {
    expect(recoveryFor(undefined, server).kind).toBe('none');
    expect(
      recoveryFor({ baseRevision: 3, definition: { ...server.definition }, savedAt: 'x' }, server)
        .kind,
    ).toBe('none');
  });

  it('offers to restore edits made on the draft the server still has', () => {
    expect(recoveryFor({ baseRevision: 4, definition: edited, savedAt: 'x' }, server).kind).toBe(
      'restore',
    );
  });

  it('warns when somebody saved since the edits were made', () => {
    expect(recoveryFor({ baseRevision: 3, definition: edited, savedAt: 'x' }, server).kind).toBe(
      'stale',
    );
    expect(recoveryFor({ baseRevision: 4, definition: edited, savedAt: 'x' }, undefined).kind).toBe(
      'stale',
    );
    expect(
      recoveryFor({ baseRevision: null, definition: edited, savedAt: 'x' }, undefined).kind,
    ).toBe('restore');
  });

  it('ignores a local copy it cannot read', () => {
    expect(parseLocalCopy('not json')).toBeUndefined();
    expect(parseLocalCopy('{"definition":1}')).toBeUndefined();
    expect(parseLocalCopy(null)).toBeUndefined();
    expect(
      parseLocalCopy(JSON.stringify({ baseRevision: 2, definition: {}, savedAt: 'now' })),
    ).toEqual({ baseRevision: 2, definition: {}, savedAt: 'now' });
  });
});

describe('calculations', () => {
  it('round-trips a left-to-right chain, and evaluates it the way it reads', () => {
    const chain = {
      first: { kind: 'field' as const, field: 'hours' },
      rest: [
        { operator: 'multiply' as const, term: { kind: 'field' as const, field: 'rate' } },
        { operator: 'add' as const, term: { kind: 'number' as const, value: '25' } },
      ],
    };
    const expression = fromCalculation(chain);
    expect(toCalculation(expression)).toEqual(chain);

    const definition: FormDefinition = {
      ...base(),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'section_1',
              fields: [
                { id: 'hours', type: 'number', label: { en: 'Hours' } },
                { id: 'rate', type: 'number', label: { en: 'Rate' } },
                { id: 'total', type: 'number', label: { en: 'Total' }, calculation: expression },
              ],
            },
          ],
        },
      ],
    };
    const compiled = compileDefinition(definition);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(evaluateForm(compiled.form, { hours: 3, rate: 40 }).values.get('total')).toBe(145);
    }
  });

  it('refuses to show as a chain anything that is not one', () => {
    const grouped: Expression = {
      kind: 'arithmetic',
      operator: 'multiply',
      left: { kind: 'answer', field: 'a' },
      right: {
        kind: 'arithmetic',
        operator: 'add',
        left: { kind: 'answer', field: 'b' },
        right: { kind: 'number', value: '1' },
      },
    };
    expect(toCalculation(grouped)).toBeUndefined();
    expect(toCalculation({ kind: 'today' })).toBeUndefined();
    expect(toCalculation(undefined)).toBeUndefined();
  });
});

describe('localized text', () => {
  it('shows the language asked for, then English, then anything', () => {
    expect(say({ en: 'Result', ar: 'النتيجة' }, 'ar')).toBe('النتيجة');
    expect(say({ en: 'Result' }, 'ar')).toBe('Result');
    expect(say({ fr: 'Résultat' }, 'ar')).toBe('Résultat');
    expect(say(undefined, 'en')).toBe('');
  });

  it('removes a language when its text is cleared, and the whole text when none is left', () => {
    expect(withText({ en: 'Help', ar: 'مساعدة' }, 'ar', '')).toEqual({ en: 'Help' });
    expect(withText({ en: 'Help' }, 'en', '')).toBeUndefined();
    expect(withText(undefined, 'en', 'New')).toEqual({ en: 'New' });
  });
});

describe('answer keys from wording', () => {
  const worded = (definition: FormDefinition, id: string, label: string) => {
    const result = updateField(definition, id, (field) => ({ ...field, label: { en: label } }));
    if ('error' in result) {
      throw new Error('setup');
    }
    return result;
  };

  it('keys a new question by what it asks, once it is worded', () => {
    const definition = worded(withField(base(), 'short_answer'), 'short_answer', 'Serial number');
    const renamed = keyFromWording(definition, 'short_answer', 'en', new Set());
    expect(renamed?.id).toBe('serial_number');
    expect(renamed?.definition.pages[0]?.sections[0]?.fields[0]?.id).toBe('serial_number');
  });

  it('never changes a key a published version used', () => {
    const definition = worded(withField(base(), 'short_answer'), 'short_answer', 'Serial number');
    expect(
      keyFromWording(definition, 'short_answer', 'en', new Set(['short_answer'])),
    ).toBeUndefined();
  });

  it('never takes a key a published version used for something else', () => {
    const definition = worded(withField(base(), 'short_answer'), 'short_answer', 'Reason');
    expect(keyFromWording(definition, 'short_answer', 'en', new Set(['reason']))?.id).toBe(
      'reason_2',
    );
  });

  it('never changes a key a rule reads', () => {
    let definition = worded(withField(withField(base(), 'a'), 'b'), 'a', 'Result');
    const ruled = updateField(definition, 'b', (field) => ({
      ...field,
      visibleWhen: { kind: 'answered', field: 'a' },
    }));
    if ('error' in ruled) {
      throw new Error('setup');
    }
    definition = ruled;
    expect(keyFromWording(definition, 'a', 'en', new Set())).toBeUndefined();
  });

  it('leaves the key alone when the wording has nothing to key by', () => {
    const definition = worded(withField(base(), 'short_answer'), 'short_answer', 'رقم المسلسل');
    expect(keyFromWording(definition, 'short_answer', 'ar', new Set())).toBeUndefined();
  });
});

describe('the selection counter', () => {
  it('moves when something else is selected, and stays for a rename', () => {
    let state = initialEditor(withField(base(), 'a'));
    state = editorReducer(state, { type: 'select', id: 'a' });
    const selected = state.selection;
    const renamed = keyFromWording(
      (() => {
        const result = updateField(state.definition, 'a', (field) => ({
          ...field,
          label: { en: 'Serial' },
        }));
        if ('error' in result) {
          throw new Error('setup');
        }
        return result;
      })(),
      'a',
      'en',
      new Set(),
    )!;
    state = editorReducer(state, {
      type: 'edit',
      apply: () => renamed.definition,
      select: renamed.id,
      renamed: true,
    });
    expect(state.selected).toBe('serial');
    expect(state.selection).toBe(selected);

    state = editorReducer(state, { type: 'select', id: 'page_1' });
    expect(state.selection).toBe(selected + 1);
  });
});

describe('opening the element a problem is in', () => {
  it('opens the question whose rule is broken, not the question the rule names', () => {
    const definition = withField(withField(base(), 'a'), 'b');
    expect(
      issueElement(definition, {
        path: 'pages[0].sections[0].fields[1].visibleWhen',
        elements: ['deleted'],
      }),
    ).toBe('b');
    expect(issueElement(definition, { path: 'pages[0].sections[0]', elements: [] })).toBe(
      'section_1',
    );
  });

  it('falls back to a named element that still exists', () => {
    const definition = withField(base(), 'a');
    expect(issueElement(definition, { path: 'pages[4]', elements: ['gone', 'a'] })).toBe('a');
    expect(issueElement(definition, { path: '', elements: ['gone'] })).toBeUndefined();
  });
});
