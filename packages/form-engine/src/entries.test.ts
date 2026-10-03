import { describe, expect, it } from 'vitest';
import {
  clauseProblem,
  type ConditionModel,
  fromExpression,
  toExpression,
} from './authoring/conditions.js';
import { diffDefinitions } from './authoring/diff.js';
import { duplicate, referencesTo, subtreeIds } from './authoring/editing.js';
import type { CompiledForm } from './compile.js';
import type { Expression } from './expression.js';
import { mediaReferences, reportableFields } from './reporting.js';
import {
  createFormState,
  type FormEvent,
  type FormState,
  toSubmission,
  transition,
  viewForm,
} from './state.js';
import {
  answer,
  compiled,
  definition,
  eq,
  field,
  gt,
  issuesOf,
  num,
  options,
  page,
  photo,
  section,
  text,
} from './test-support/builders.js';
import { validateSubmission } from './validation.js';
import { migrateAnswers } from './versioning.js';

/**
 * Repeatable sections (P13b), one behaviour at a time. The conformance corpus
 * pins every decision byte for byte; these say in words what each one is.
 */

const count = (sectionId: string): Expression => ({ kind: 'count', section: sectionId });
const aggregate = (
  operator: 'sum' | 'min' | 'max',
  sectionId: string,
  fieldId: string,
): Expression => ({
  kind: 'aggregate',
  operator,
  section: sectionId,
  field: fieldId,
});
const some = (sectionId: string, condition: Expression): Expression => ({
  kind: 'some',
  section: sectionId,
  condition,
});
const every = (sectionId: string, condition: Expression): Expression => ({
  kind: 'every',
  section: sectionId,
  condition,
});

const repeat = (maxEntries = 5, extra: Record<string, unknown> = {}) => ({
  repeat: { maxEntries, entryLabel: { en: 'Radiator' }, ...extra },
});

/** Radiators, each with a room, an output and a result; a summary reading across them. */
function radiators(
  summary: ReturnType<typeof field>[] = [],
  extra: Record<string, unknown> = {},
): CompiledForm {
  return compiled(
    definition([
      page('page_1', [
        section(
          'radiators',
          [
            field('text', 'room', { required: true, default: 'Lounge' }),
            field('number', 'watts'),
            field('radio', 'result', { options: options('pass', 'fail') }),
            field('text', 'fault', {
              required: true,
              visibleWhen: eq(answer('result'), text('fail')),
            }),
            field('photo', 'evidence'),
          ],
          repeat(3, extra),
        ),
        section('summary', summary),
      ]),
    ]),
  );
}

function play(form: CompiledForm, events: FormEvent[], state: FormState = createFormState(form)) {
  let current = state;
  const refusals: string[] = [];
  for (const event of events) {
    const result = transition(form, current, event);
    current = result.state;
    if (!result.accepted) {
      refusals.push(result.reason);
    }
  }
  return { state: current, refusals };
}

const add = (entry: string, index?: number): FormEvent =>
  index === undefined
    ? { type: 'add_entry', section: 'radiators', entry }
    : { type: 'add_entry', section: 'radiators', entry, index };
const set = (entry: string, fieldId: string, value: unknown): FormEvent => ({
  type: 'answer',
  field: fieldId,
  value,
  entry,
});

describe('publishing a repeatable section', () => {
  it('refuses reading an entry’s answer from outside its entries, and limits that make no sense', () => {
    const issues = issuesOf(
      definition([
        page('page_1', [
          section(
            'rows',
            [field('number', 'reading')],
            repeat(2, { minEntries: 3, titleField: 'nowhere' }),
          ),
          section('after', [
            field('text', 'note', { visibleWhen: gt(answer('reading'), num('1')) }),
          ]),
        ]),
      ]),
    );
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['invalid_repeat', 'pages[0].sections[0].repeat.minEntries'],
      ['invalid_repeat', 'pages[0].sections[0].repeat.titleField'],
      ['inside_repeat', 'pages[0].sections[1].fields[0].visibleWhen'],
    ]);
  });

  it('allows a rule inside an entry to read its own entry and the rest of the form', () => {
    expect(() =>
      compiled(
        definition([
          page('page_1', [
            section('before', [field('yes_no', 'rental')]),
            section(
              'rows',
              [
                field('number', 'reading'),
                field('text', 'why', {
                  visibleWhen: {
                    kind: 'all',
                    operands: [gt(answer('reading'), num('3')), eq(answer('rental'), text('yes'))],
                  },
                }),
              ],
              repeat(),
            ),
          ]),
        ]),
      ),
    ).not.toThrow();
  });
});

describe('reading across entries', () => {
  const form = radiators([
    field('number', 'how_many', { calculation: count('radiators') }),
    field('number', 'total_watts', { calculation: aggregate('sum', 'radiators', 'watts') }),
    field('number', 'smallest', { calculation: aggregate('min', 'radiators', 'watts') }),
    field('text', 'any_failed', {
      visibleWhen: some('radiators', eq(answer('result'), text('fail'))),
    }),
    field('text', 'all_passed', {
      visibleWhen: every('radiators', eq(answer('result'), text('pass'))),
    }),
  ]);

  it('counts none, sums to 0 and has no smallest before any entry, and every entry of none passed', () => {
    const view = viewForm(form, createFormState(form));
    expect(view.values.get('how_many')).toBe(0);
    expect(view.values.get('total_watts')).toBe(0);
    expect(view.values.has('smallest')).toBe(false);
    expect(view.visible.get('any_failed')).toBe(false);
    expect(view.visible.get('all_passed')).toBe(true);
  });

  it('sums only what is known, and leaves "every" unknown until each entry is answered', () => {
    const { state } = play(form, [
      add('r1'),
      add('r2'),
      set('r1', 'watts', 800),
      set('r1', 'result', 'pass'),
    ]);
    const view = viewForm(form, state);
    expect(view.values.get('how_many')).toBe(2);
    expect(view.values.get('total_watts')).toBe(800);
    expect(view.values.get('smallest')).toBe(800);
    expect(view.visible.get('all_passed')).toBe(false);

    const failed = play(form, [set('r2', 'watts', 400), set('r2', 'result', 'fail')], state).state;
    const after = viewForm(form, failed);
    expect(after.values.get('total_watts')).toBe(1200);
    expect(after.values.get('smallest')).toBe(400);
    expect(after.visible.get('any_failed')).toBe(true);
    expect(after.visible.get('all_passed')).toBe(false);
  });

  it('gives a hidden repeatable section no entries for anything to read', () => {
    const hidden = compiled(
      definition([
        page('page_1', [
          section('first', [field('checkbox', 'has_radiators')]),
          section('radiators', [field('number', 'watts')], {
            ...repeat(),
            visibleWhen: eq(answer('has_radiators'), { kind: 'boolean', value: true }),
          }),
          section('summary', [field('number', 'how_many', { calculation: count('radiators') })]),
        ]),
      ]),
    );
    const { state } = play(hidden, [
      { type: 'answer', field: 'has_radiators', value: true },
      add('r1'),
      set('r1', 'watts', 5),
      { type: 'answer', field: 'has_radiators', value: false },
    ]);
    const view = viewForm(hidden, state);
    expect(view.values.get('how_many')).toBe(0);
    expect(view.entries.get('radiators')).toEqual([]);
    expect(toSubmission(hidden, state)).toEqual({ has_radiators: false });
  });
});

describe('filling entries', () => {
  it('adds with defaults, refuses past the maximum and a reused id, and forgets what was touched in a removed entry', () => {
    const form = radiators();
    const { state, refusals } = play(form, [
      add('r1'),
      add('r2', 0),
      add('r2'),
      add('not an id!'),
      add('r3'),
      add('r4'),
      { type: 'touch', field: 'room', entry: 'r3' },
      { type: 'touch', field: 'room', entry: 'r1' },
      { type: 'move_entry', section: 'radiators', entry: 'r3', index: 0 },
      { type: 'remove_entry', section: 'radiators', entry: 'r1' },
      { type: 'answer', field: 'room', value: 'Hall' },
    ]);
    expect(refusals).toEqual([
      'invalid_entry_id',
      'invalid_entry_id',
      'too_many_entries',
      'entry_needed',
    ]);
    expect(state.answers.radiators).toEqual([
      { id: 'r3', values: { room: 'Lounge' } },
      { id: 'r2', values: { room: 'Lounge' } },
    ]);
    expect(state.touched).toEqual(['r3/room']);
  });

  it('opens with as many entries as a section needs, when the caller can name them', () => {
    const form = radiators([], { minEntries: 2 });
    let next = 0;
    const state = createFormState(form, {}, { newEntryId: () => `new-${String((next += 1))}` });
    expect(state.answers.radiators).toEqual([
      { id: 'new-1', values: { room: 'Lounge' } },
      { id: 'new-2', values: { room: 'Lounge' } },
    ]);
    expect(createFormState(form).answers).toEqual({});
  });

  it('names each error by its entry, and removing the last entry stores no answer', () => {
    const form = radiators([], { minEntries: 1 });
    const { state } = play(form, [add('r1'), set('r1', 'room', ''), set('r1', 'result', 'fail')]);
    expect(viewForm(form, state).errors).toEqual([
      { field: 'room', code: 'required', params: {}, entry: 'r1' },
      { field: 'fault', code: 'required', params: {}, entry: 'r1' },
    ]);
    const emptied = play(
      form,
      [{ type: 'remove_entry', section: 'radiators', entry: 'r1' }],
      state,
    ).state;
    expect(emptied.answers).toEqual({});
    expect(viewForm(form, emptied).errors).toEqual([
      { field: 'radiators', code: 'too_few_entries', params: { minimum: '1' } },
    ]);
  });
});

describe('what a server receives', () => {
  const form = radiators([field('number', 'how_many', { calculation: count('radiators') })]);

  it('accepts what the engine sends, with hidden answers left out of each entry', () => {
    const { state } = play(form, [
      add('r1'),
      set('r1', 'result', 'fail'),
      set('r1', 'fault', 'Cold'),
      set('r1', 'result', 'pass'),
    ]);
    const submission = toSubmission(form, state);
    expect(submission).toEqual({
      radiators: [{ id: 'r1', values: { room: 'Lounge', result: 'pass' } }],
    });
    expect(validateSubmission(form, submission)).toMatchObject({
      valid: true,
      answers: { radiators: submission.radiators, how_many: 1 },
    });
  });

  it('refuses a stray key in an entry, a field of an entry at the top, and a list that is not entries', () => {
    expect(
      validateSubmission(form, {
        room: 'Loft',
        radiators: [{ id: 'r1', values: { room: 'Loft', colour: 'white', watts: '900' } }],
      }),
    ).toMatchObject({
      valid: false,
      issues: [
        { code: 'unknown_field', field: 'colour', entry: 'r1' },
        { code: 'unknown_field', field: 'room' },
      ],
      errors: [{ field: 'watts', code: 'invalid', params: {}, entry: 'r1' }],
    });
    expect(validateSubmission(form, { radiators: [{ id: 'r1' }] }).errors).toEqual([
      { field: 'radiators', code: 'invalid', params: {} },
    ]);
  });
});

describe('moving entries to a new version', () => {
  it('carries each entry by id, reporting what each entry lost', () => {
    const before = radiators();
    const after = compiled(
      definition([
        page('page_1', [
          section(
            'radiators',
            [field('text', 'room'), field('radio', 'result', { options: options('pass') })],
            repeat(1),
          ),
        ]),
      ]),
    );
    const { state } = play(before, [
      add('r1'),
      set('r1', 'watts', 5),
      add('r2'),
      set('r2', 'result', 'fail'),
      set('r2', 'fault', 'x'),
    ]);
    expect(migrateAnswers(before, after, state.answers)).toEqual({
      answers: {
        radiators: [
          { id: 'r1', values: { room: 'Lounge' } },
          { id: 'r2', values: { room: 'Lounge' } },
        ],
      },
      carried: ['room'],
      dropped: [
        { field: 'watts', reason: 'field_removed', entry: 'r1' },
        { field: 'result', reason: 'option_removed', entry: 'r2' },
        { field: 'fault', reason: 'field_removed', entry: 'r2' },
      ],
      trimmed: [],
      nowInvalid: ['radiators'],
    });
  });
});

describe('reporting entries', () => {
  it('marks each reportable field of a repeatable section with it, and finds files inside entries', () => {
    const form = radiators();
    expect(reportableFields(form.definition)).toEqual([
      { field: 'room', type: 'text', multiple: false, section: 'radiators' },
      { field: 'watts', type: 'number', multiple: false, section: 'radiators' },
      { field: 'result', type: 'text', multiple: false, section: 'radiators' },
      { field: 'fault', type: 'text', multiple: false, section: 'radiators' },
    ]);
    expect(
      mediaReferences(form.definition, {
        radiators: [
          { id: 'r1', values: { evidence: [photo()] } },
          { id: 'r2', values: {} },
        ],
      }),
    ).toEqual([{ field: 'evidence', media: photo(), entry: 'r1' }]);
  });
});

describe('building with entries', () => {
  const lookup = (form: CompiledForm) => (id: string) => form.elements.get(id)?.field;

  it('reads "any radiator’s result is fail" and "the number of radiators is at least 2" back as clauses', () => {
    const form = radiators();
    const model: ConditionModel = {
      match: 'all',
      clauses: [
        {
          field: 'result',
          operator: 'is',
          value: 'fail',
          entries: { section: 'radiators', quantifier: 'some' },
        },
        { field: 'radiators', operator: 'is_at_least', value: '2', subject: 'entry_count' },
      ],
    };
    const expression = toExpression(model, lookup(form));
    expect(expression).toEqual({
      kind: 'all',
      operands: [
        some('radiators', eq(answer('result'), text('fail'))),
        { kind: 'compare', operator: 'ge', left: count('radiators'), right: num('2') },
      ],
    });
    expect(fromExpression(expression, lookup(form))).toEqual(model);
    expect(
      clauseProblem(
        { field: 'radiators', operator: 'is_at_least', value: '1.5', subject: 'entry_count' },
        lookup(form),
      ),
    ).toBe('value_invalid');
  });

  it('duplicates a repeatable section with its title and rules pointing at the copy, and warns before deleting one that is counted', () => {
    const form = radiators([field('number', 'how_many', { calculation: count('radiators') })], {
      titleField: 'room',
    });
    const copied = duplicate(form.definition, 'radiators');
    if ('error' in copied) {
      throw new Error(copied.error);
    }
    const copy = copied.definition.pages[0]!.sections[1]!;
    expect(copy.repeat?.titleField).toBe('room_copy');
    expect(copy.fields.find((candidate) => candidate.id === 'fault_copy')?.visibleWhen).toEqual(
      eq(answer('result_copy'), text('fail')),
    );
    expect(referencesTo(form.definition, subtreeIds(form.definition, 'radiators'))).toEqual([
      { from: 'how_many', where: 'calculation', to: 'radiators' },
    ]);
  });

  it('calls moving a question into a repeatable section, and lowering its limit, breaking', () => {
    const live = radiators([field('text', 'notes')]);
    const draft = compiled(
      definition([
        page('page_1', [
          section(
            'radiators',
            [...live.definition.pages[0]!.sections[0]!.fields, field('text', 'notes')],
            repeat(2),
          ),
          section('summary', []),
        ]),
      ]),
    );
    expect(diffDefinitions(live.definition, draft.definition).breaking).toEqual([
      {
        field: 'radiators',
        reason: 'constraint_tightened',
        affects: 'drafts',
        detail: ['maxEntries'],
      },
      { field: 'notes', reason: 'entries_changed', affects: 'reporting', detail: [] },
    ]);
  });
});
