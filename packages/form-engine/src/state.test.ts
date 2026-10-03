import { describe, expect, it } from 'vitest';
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
  answered,
  compiled,
  eq,
  field,
  fields,
  num,
  options,
  plus,
  text,
} from './test-support/builders.js';

const form = compiled(
  fields(
    field('radio', 'result', { options: options('pass', 'fail'), required: true }),
    field('text', 'reason', { required: true, visibleWhen: eq(answer('result'), text('fail')) }),
    field('number', 'parts', { default: 2 }),
    field('number', 'total', { calculation: plus(answer('parts'), num('1')) }),
    field('text', 'reference', { readOnly: true, default: 'JOB-1' }),
    field('multi_select', 'faults', { options: options('leak', 'noise') }),
    field('text', 'constructor', { default: 'prototype-safe' }),
    field('checkbox', 'confirmed', { visibleWhen: answered('result') }),
  ),
);

const run = (events: FormEvent[], start: FormState = createFormState(form)) =>
  events.reduce((state, event) => transition(form, state, event).state, start);

describe('creating a form', () => {
  it('fills in defaults, including for a field whose id is also an Object property', () => {
    expect(createFormState(form)).toEqual({
      status: 'editing',
      answers: { parts: 2, reference: 'JOB-1', constructor: 'prototype-safe' },
      touched: [],
      submitAttempted: false,
    });
  });

  it('never overwrites a resumed draft with a default', () => {
    expect(createFormState(form, { parts: 7 }).answers.parts).toBe(7);
  });
});

describe('transitions', () => {
  it('records an answer', () => {
    const next = transition(form, createFormState(form), {
      type: 'answer',
      field: 'result',
      value: 'fail',
    });
    expect(next).toMatchObject({ accepted: true });
    expect(next.state.answers.result).toBe('fail');
  });

  it('stores an empty answer as cleared, and clears on request', () => {
    const answered_ = run([{ type: 'answer', field: 'faults', value: ['leak'] }]);
    expect(
      run([{ type: 'answer', field: 'faults', value: [] }], answered_).answers,
    ).not.toHaveProperty('faults');
    expect(run([{ type: 'clear', field: 'parts' }]).answers).not.toHaveProperty('parts');
  });

  it.each([
    [{ type: 'answer', field: 'nope', value: 'x' }, 'unknown_field'],
    [{ type: 'answer', field: 'reference', value: 'JOB-2' }, 'read_only'],
    [{ type: 'clear', field: 'reference' }, 'read_only'],
    [{ type: 'answer', field: 'total', value: 99 }, 'calculated'],
    [{ type: 'answer', field: 'parts', value: 'two' }, 'wrong_shape'],
    [{ type: 'reopen' }, 'not_submitted'],
  ] as [FormEvent, string][])('refuses %j with %s, leaving state untouched', (event, reason) => {
    const state = createFormState(form);
    const result = transition(form, state, event);
    expect(result).toEqual({ accepted: false, state, reason });
  });

  it('remembers each touched field once, in the order first left', () => {
    const state = run([
      { type: 'touch', field: 'result' },
      { type: 'touch', field: 'parts' },
      { type: 'touch', field: 'result' },
    ]);
    expect(state.touched).toEqual(['result', 'parts']);
    expect(transition(form, state, { type: 'touch', field: 'ghost' })).toMatchObject({
      accepted: false,
      reason: 'unknown_field',
    });
  });

  it('refuses to submit an invalid form, but switches on its error messages', () => {
    const result = transition(form, createFormState(form), { type: 'submit' });
    expect(result).toMatchObject({ accepted: false, reason: 'invalid' });
    expect(result.state.submitAttempted).toBe(true);
    expect(result.state.status).toBe('editing');
  });

  it('submits a valid form, freezes it, and reopens it on request', () => {
    const submitted = run([{ type: 'answer', field: 'result', value: 'pass' }, { type: 'submit' }]);
    expect(submitted.status).toBe('submitted');

    for (const event of [
      { type: 'answer', field: 'result', value: 'fail' },
      { type: 'touch', field: 'result' },
      { type: 'submit' },
    ] as FormEvent[]) {
      expect(transition(form, submitted, event)).toMatchObject({
        accepted: false,
        reason: 'not_editing',
      });
    }

    expect(transition(form, submitted, { type: 'reopen' })).toMatchObject({
      accepted: true,
      state: { status: 'editing' },
    });
  });
});

describe('the view', () => {
  it('derives visibility, calculated values and progress from state alone', () => {
    const view = viewForm(form, run([{ type: 'answer', field: 'result', value: 'fail' }]));

    expect(view.visible.get('reason')).toBe(true);
    expect(view.values.get('total')).toBe(3);
    expect(view.valid).toBe(false);
    // Visible typed fields: result, reason, parts, reference, faults, constructor, confirmed.
    expect(view.progress).toEqual({ requiredAnswered: 1, requiredTotal: 2, answered: 4, total: 7 });
  });

  it('shows no error until the field is left, or a submit is attempted', () => {
    const fresh = createFormState(form);
    expect(viewForm(form, fresh).errors.map((error) => error.field)).toEqual(['result']);
    expect(viewForm(form, fresh).shownErrors).toEqual([]);

    expect(
      viewForm(form, run([{ type: 'touch', field: 'result' }])).shownErrors.map(
        (error) => error.field,
      ),
    ).toEqual(['result']);
    expect(
      viewForm(form, run([{ type: 'submit' }])).shownErrors.map((error) => error.field),
    ).toEqual(['result']);
  });

  it('counts a field satisfied the moment its rule is, and stops counting it once hidden', () => {
    const failing = run([
      { type: 'answer', field: 'result', value: 'fail' },
      { type: 'answer', field: 'reason', value: 'Seal perished' },
    ]);
    expect(viewForm(form, failing).progress.requiredAnswered).toBe(2);

    const passing = run([{ type: 'answer', field: 'result', value: 'pass' }], failing);
    expect(viewForm(form, passing).progress).toMatchObject({
      requiredAnswered: 1,
      requiredTotal: 1,
    });
  });
});

describe('the submission', () => {
  it('sends visible answers only, and never a calculated value or a hidden field’s answer', () => {
    const state = run([
      { type: 'answer', field: 'result', value: 'fail' },
      { type: 'answer', field: 'reason', value: 'Seal perished' },
      { type: 'answer', field: 'result', value: 'pass' },
    ]);

    expect(state.answers.reason).toBe('Seal perished');
    expect(toSubmission(form, state)).toEqual({
      result: 'pass',
      parts: 2,
      reference: 'JOB-1',
      constructor: 'prototype-safe',
    });
  });
});
