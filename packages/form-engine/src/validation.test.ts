import { describe, expect, it } from 'vitest';
import {
  answer,
  answered,
  compiled,
  definition,
  eq,
  field,
  fields,
  gt,
  label,
  lt,
  num,
  options,
  page,
  plus,
  section,
  text,
  today,
} from './test-support/builders.js';
import { validateForm, validateSubmission } from './validation.js';

const inspection = compiled(
  definition([
    page('page_1', [
      section('main', [
        field('radio', 'result', { options: options('pass', 'fail'), required: true }),
        field('text', 'reason', {
          required: true,
          minLength: 5,
          visibleWhen: eq(answer('result'), text('fail')),
        }),
        field('checkbox', 'isolated', { required: true }),
        field('number', 'readings', { min: 1 }),
      ]),
      section('extra', [field('text', 'extra_notes', { required: true })], {
        visibleWhen: answered('readings'),
      }),
    ]),
  ]),
);

describe('validateForm', () => {
  it('reports every problem on a blank form, in reading order', () => {
    const { errors, valid } = validateForm(inspection, {});
    expect(valid).toBe(false);
    expect(errors.map((error) => `${error.field}:${error.code}`)).toEqual([
      'result:required',
      'isolated:required',
    ]);
  });

  it('does not require a field that is hidden, or a field in a hidden section', () => {
    const { errors } = validateForm(inspection, { result: 'pass', isolated: true });
    expect(errors).toEqual([]);
  });

  it('requires a field as soon as it becomes visible', () => {
    expect(validateForm(inspection, { result: 'fail', isolated: true }).errors).toEqual([
      { field: 'reason', code: 'required', params: {} },
    ]);
    expect(
      validateForm(inspection, { result: 'pass', isolated: true, readings: 3 }).errors,
    ).toEqual([{ field: 'extra_notes', code: 'required', params: {} }]);
  });

  it('means "ticked" when a checkbox is required', () => {
    expect(validateForm(inspection, { result: 'pass', isolated: false }).errors).toEqual([
      { field: 'isolated', code: 'required', params: {} },
    ]);
  });

  it('checks the rules of an answered field', () => {
    expect(
      validateForm(inspection, {
        result: 'fail',
        reason: 'bad',
        isolated: true,
        readings: 0,
        extra_notes: 'x',
      }).errors,
    ).toEqual([
      { field: 'reason', code: 'too_short', params: { minimum: '5' } },
      { field: 'readings', code: 'below_minimum', params: { minimum: '1' } },
    ]);
  });

  it('ignores the stale answer to a field that has since been hidden', () => {
    const { errors, evaluation } = validateForm(inspection, {
      result: 'pass',
      reason: 'x',
      isolated: true,
    });
    expect(errors).toEqual([]);
    expect(evaluation.values.has('reason')).toBe(false);
  });

  describe('custom rules', () => {
    const visit = compiled(
      fields(
        field('time', 'arrived', { required: true }),
        field('time', 'left', {
          rules: [
            {
              id: 'after_arrival',
              assert: gt(answer('left'), answer('arrived')),
              message: label('You cannot leave before you arrive'),
            },
          ],
        }),
      ),
    );

    it('fail when their assertion is definitely false, naming the rule', () => {
      expect(validateForm(visit, { arrived: '10:00', left: '09:30' }).errors).toEqual([
        { field: 'left', code: 'rule_failed', params: { rule: 'after_arrival' } },
      ]);
    });

    it('pass when it is true, and do not fire when it is unknown', () => {
      expect(validateForm(visit, { arrived: '10:00', left: '10:30' }).errors).toEqual([]);
      // "left" blank: the comparison is unknown, and a blank optional field is not wrong.
      expect(validateForm(visit, { arrived: '10:00' }).errors).toEqual([]);
    });

    it('can be relative to today, which the caller supplies', () => {
      const dated = compiled(
        fields(
          field('date', 'visited', {
            rules: [
              {
                id: 'not_future',
                assert: lt(answer('visited'), today()),
                message: label('No future visits'),
              },
            ],
          }),
        ),
      );
      expect(
        validateForm(dated, { visited: '2026-09-20' }, { today: '2026-09-13' }).errors.map(
          (error) => error.code,
        ),
      ).toEqual(['rule_failed']);
      expect(
        validateForm(dated, { visited: '2026-09-01' }, { today: '2026-09-13' }).errors,
      ).toEqual([]);
    });
  });

  it('never validates a calculated field', () => {
    const totals = compiled(
      fields(
        field('number', 'a'),
        field('number', 'total', { min: 100, calculation: plus(answer('a'), num('1')) }),
      ),
    );
    expect(validateForm(totals, { a: 1 }).errors).toEqual([]);
  });
});

describe('validateSubmission — what the server does with what a client sent', () => {
  const quote = compiled(
    fields(
      field('yes_no', 'callout', { required: true }),
      field('decimal', 'fee', {
        decimalPlaces: 2,
        visibleWhen: eq(answer('callout'), text('yes')),
      }),
      field('decimal', 'total', { decimalPlaces: 2, calculation: plus(answer('fee'), num('10')) }),
    ),
  );

  it('accepts a correct submission and returns the answers to store, with the server’s own calculation', () => {
    const check = validateSubmission(quote, { callout: 'yes', fee: '35.00' });
    expect(check).toEqual({
      valid: true,
      issues: [],
      errors: [],
      answers: { callout: 'yes', fee: '35.00', total: '45.00' },
    });
  });

  it('refuses a field the form does not have', () => {
    expect(validateSubmission(quote, { callout: 'no', discount: '5' }).issues).toEqual([
      { code: 'unknown_field', field: 'discount' },
    ]);
  });

  it('refuses a client’s own value for a calculated field, however plausible', () => {
    const check = validateSubmission(quote, { callout: 'yes', fee: '35.00', total: '1.00' });
    expect(check.valid).toBe(false);
    expect(check.issues).toEqual([{ code: 'answer_to_calculated_field', field: 'total' }]);
  });

  it('refuses an answer to a field that is hidden for these answers', () => {
    expect(validateSubmission(quote, { callout: 'no', fee: '35.00' }).issues).toEqual([
      { code: 'answer_to_hidden_field', field: 'fee' },
    ]);
  });

  it('refuses a submission that breaks the form’s rules, field by field', () => {
    const check = validateSubmission(quote, { fee: '35.001' });
    expect(check.valid).toBe(false);
    expect(check.issues).toEqual([{ code: 'answer_to_hidden_field', field: 'fee' }]);
    expect(check.errors).toEqual([{ field: 'callout', code: 'required', params: {} }]);
  });

  it('refuses something that is not an answers object at all', () => {
    for (const body of [null, [], 'answers', 42]) {
      expect(validateSubmission(quote, body)).toEqual({
        valid: false,
        issues: [{ code: 'not_an_object', field: undefined }],
        errors: [],
        answers: {},
      });
    }
  });

  it('reports issues in a stable order, whatever order the keys arrived in', () => {
    const one = validateSubmission(quote, { zeta: 1, alpha: 2, callout: 'no' });
    const two = validateSubmission(quote, { callout: 'no', alpha: 2, zeta: 1 });
    expect(one.issues).toEqual([
      { code: 'unknown_field', field: 'alpha' },
      { code: 'unknown_field', field: 'zeta' },
    ]);
    expect(two.issues).toEqual(one.issues);
  });
});
