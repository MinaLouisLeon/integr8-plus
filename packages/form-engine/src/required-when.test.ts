import { describe, expect, it } from 'vitest';
import { diffDefinitions } from './authoring/diff.js';
import { duplicate, findField, isEditError, referencesTo } from './authoring/editing.js';
import { createFormState, transition, viewForm } from './state.js';
import {
  answer,
  compiled,
  definition,
  eq,
  field,
  fields,
  includes,
  issuesOf,
  options,
  page,
  section,
  text,
} from './test-support/builders.js';
import { validateForm, validateSubmission } from './validation.js';

/**
 * Required only when: a field that must be answered in some cases and not
 * others. The rule follows the answers, so the renderer asks the view rather
 * than the definition; the server asks the same function.
 */

const result = field('radio', 'result', { options: options('pass', 'fail'), required: true });
const reason = field('text', 'reason', { requiredWhen: eq(answer('result'), text('fail')) });
const faults = field('multi_select', 'faults', { options: options('leak', 'gas') });
const isolated = field('checkbox', 'isolated', { requiredWhen: includes('faults', 'gas') });

const form = compiled(fields(result, reason, faults, isolated));

describe('validating a field that is required only when', () => {
  it('does not require it while the condition is unknown or false', () => {
    expect(validateForm(form, {}).errors.map((error) => error.field)).toEqual(['result']);
    expect(validateForm(form, { result: 'pass' }).errors).toEqual([]);
  });

  it('requires it as soon as the condition is definitely true', () => {
    expect(validateForm(form, { result: 'fail' }).errors).toEqual([
      { field: 'reason', code: 'required', params: {} },
    ]);
    expect(validateForm(form, { result: 'fail', reason: 'Seal' }).errors).toEqual([]);
  });

  it('means "ticked" on a checkbox, as a fixed required does', () => {
    expect(validateForm(form, { result: 'pass', faults: ['gas'], isolated: false }).errors).toEqual(
      [{ field: 'isolated', code: 'required', params: {} }],
    );
    expect(
      validateForm(form, { result: 'pass', faults: ['leak'], isolated: false }).errors,
    ).toEqual([]);
  });

  it('tells the view which fields are required right now, and counts them in progress', () => {
    let state = createFormState(form);
    let view = viewForm(form, state);
    expect([...view.required]).toEqual([
      ['result', true],
      ['reason', false],
      ['faults', false],
      ['isolated', false],
    ]);
    expect(view.progress).toEqual({ requiredAnswered: 0, requiredTotal: 1, answered: 0, total: 4 });

    state = transition(form, state, { type: 'answer', field: 'result', value: 'fail' }).state;
    view = viewForm(form, state);
    expect(view.required.get('reason')).toBe(true);
    expect(view.progress).toEqual({ requiredAnswered: 1, requiredTotal: 2, answered: 1, total: 4 });
  });

  it('is judged the same way on the server', () => {
    const check = validateSubmission(form, { result: 'fail', faults: ['gas'], isolated: false });
    expect(check.valid).toBe(false);
    expect(check.errors.map((error) => `${error.field}:${error.code}`)).toEqual([
      'reason:required',
      'isolated:required',
    ]);
  });

  it('reads an entry’s own answers inside a repeatable section', () => {
    const repeating = compiled(
      definition([
        page('p', [
          section(
            'appliances',
            [
              field('radio', 'kind', { options: options('gas', 'electric') }),
              field('yes_no', 'flue_ok', { requiredWhen: eq(answer('kind'), text('gas')) }),
            ],
            { repeat: { maxEntries: 5, entryLabel: { en: 'Appliance' } } },
          ),
        ]),
      ]),
    );
    const validation = validateForm(repeating, {
      appliances: [
        { id: 'e1', values: { kind: 'gas' } },
        { id: 'e2', values: { kind: 'electric' } },
      ],
    });
    expect(validation.errors).toEqual([
      { field: 'flue_ok', code: 'required', params: {}, entry: 'e1' },
    ]);
    expect(validation.required.get('e1/flue_ok')).toBe(true);
    expect(validation.required.get('e2/flue_ok')).toBe(false);
  });
});

describe('compiling a field that is required only when', () => {
  it('checks the rule like any other condition', () => {
    const issues = issuesOf(
      fields(
        field('number', 'count'),
        field('text', 'a', { requiredWhen: answer('count') }),
        field('text', 'b', { requiredWhen: answer('missing') }),
      ),
    );
    expect(issues.map((issue) => `${issue.code}@${issue.path}`)).toEqual([
      'type_mismatch@pages[0].sections[0].fields[1].requiredWhen',
      'unknown_field@pages[0].sections[0].fields[2].requiredWhen',
    ]);
  });

  it('refuses it on a calculated field, which is never typed', () => {
    const issues = issuesOf(
      fields(
        field('number', 'parts'),
        field('number', 'total', {
          calculation: answer('parts'),
          requiredWhen: eq(answer('parts'), { kind: 'number', value: '1' }),
        }),
      ),
    );
    expect(issues).toMatchObject([
      { code: 'invalid_field_config', path: 'pages[0].sections[0].fields[1].requiredWhen' },
    ]);
  });

  it('is not a dependency: a rule may read a field whose required-ness reads it back', () => {
    expect(() =>
      compiled(
        fields(
          field('text', 'a', { requiredWhen: { kind: 'answered', field: 'b' } }),
          field('text', 'b', { requiredWhen: { kind: 'answered', field: 'a' } }),
        ),
      ),
    ).not.toThrow();
  });
});

describe('publishing a changed required-when', () => {
  const live = fields(result, field('text', 'reason'));
  const breaking = (draft: ReturnType<typeof fields>) => diffDefinitions(live, draft).breaking;

  it('flags a new rule as "now required", for drafts', () => {
    expect(breaking(fields(result, reason))).toEqual([
      { field: 'reason', reason: 'now_required', affects: 'drafts', detail: ['requiredWhen'] },
    ]);
  });

  it('flags a changed rule, but not an unchanged one or a removed one', () => {
    const was = fields(result, reason);
    const changed = fields(
      result,
      field('text', 'reason', { requiredWhen: eq(answer('result'), text('pass')) }),
    );
    expect(diffDefinitions(was, changed).breaking.map((entry) => entry.detail)).toEqual([
      ['requiredWhen'],
    ]);
    expect(diffDefinitions(was, fields(result, reason)).breaking).toEqual([]);
    expect(diffDefinitions(was, live).breaking).toEqual([]);
  });

  it('reports a fixed required once, whatever the rule does', () => {
    const fixed = fields(result, field('text', 'reason', { required: true }));
    expect(breaking(fixed)).toEqual([
      { field: 'reason', reason: 'now_required', affects: 'drafts', detail: ['required'] },
    ]);
    expect(diffDefinitions(fixed, fields(result, reason)).breaking).toEqual([]);
  });
});

describe('editing a field that is required only when', () => {
  it('names the rule as a reference before the field it reads is deleted', () => {
    expect(referencesTo(fields(result, reason), ['result'])).toEqual([
      { from: 'reason', where: 'requiredWhen', to: 'result' },
    ]);
  });

  it('points a duplicated section’s rule at the copy', () => {
    const copy = duplicate(fields(result, reason), 'section_1');
    if (isEditError(copy)) throw new Error(copy.error);
    expect(findField(copy.definition, 'reason_copy')?.requiredWhen).toEqual(
      eq(answer('result_copy'), text('fail')),
    );
  });
});
