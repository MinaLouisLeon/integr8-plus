import { describe, expect, it } from 'vitest';
import {
  evaluateExpression,
  evaluateForm,
  type RuleValue,
  type Scope,
  toRuleValue,
  truth,
} from './evaluate.js';
import type { Expression } from './expression.js';
import {
  all,
  answer,
  answered,
  any,
  bool,
  compiled,
  date,
  datetime,
  definition,
  eq,
  field,
  fields,
  ge,
  gt,
  includes,
  le,
  lt,
  minus,
  ne,
  not,
  num,
  options,
  over,
  page,
  photo,
  plus,
  section,
  text,
  time,
  times,
  today,
} from './test-support/builders.js';

const UNKNOWN: Expression = answer('blank');
const T = bool(true);
const F = bool(false);

const scope = (values: Record<string, RuleValue> = {}, context = {}): Scope => ({
  value: (id) => values[id],
  context,
});

const result = (expression: Expression, values: Record<string, RuleValue> = {}, context = {}) =>
  truth(evaluateExpression(expression, scope(values, context)));

describe('three-valued logic', () => {
  it('propagates unknown through not', () => {
    expect(result(not(T))).toBe(false);
    expect(result(not(F))).toBe(true);
    expect(result(not(UNKNOWN))).toBeUndefined();
  });

  it.each([
    [[T, T], true],
    [[T, F], false],
    [[F, UNKNOWN], false],
    [[UNKNOWN, F], false],
    [[T, UNKNOWN], undefined],
    [[UNKNOWN, UNKNOWN], undefined],
  ])('all%j is %s', (operands, expected) => {
    expect(result(all(...operands))).toBe(expected);
  });

  it.each([
    [[F, F], false],
    [[T, F], true],
    [[T, UNKNOWN], true],
    [[UNKNOWN, T], true],
    [[F, UNKNOWN], undefined],
  ])('any%j is %s', (operands, expected) => {
    expect(result(any(...operands))).toBe(expected);
  });

  it('makes any comparison with an unknown side unknown', () => {
    expect(result(eq(UNKNOWN, num('1')))).toBeUndefined();
    expect(result(ne(num('1'), UNKNOWN))).toBeUndefined();
  });

  it('never makes answered unknown', () => {
    expect(result(answered('blank'))).toBe(false);
    expect(result(answered('given'), { given: { type: 'text', value: 'x' } })).toBe(true);
  });

  it('treats anything that is not a boolean as unknown truth', () => {
    expect(truth({ type: 'text', value: 'true' })).toBeUndefined();
  });
});

describe('comparisons', () => {
  it.each([
    [eq(num('2.50'), num('2.5')), true],
    [lt(num('-1'), num('0')), true],
    [le(num('3'), num('3')), true],
    [gt(num('3'), num('3.001')), false],
    [ge(num('10'), num('9.99')), true],
    [ne(text('a'), text('b')), true],
    [eq(text('a'), text('A')), false],
    [eq(bool(true), bool(true)), true],
    [lt(date('2026-01-01'), date('2026-01-02')), true],
    [gt(time('09:00'), time('08:59')), true],
    [eq(datetime('2026-09-13T14:00+03:00'), datetime('2026-09-13T11:00Z')), true],
  ])('%j is %s', (expression, expected) => {
    expect(result(expression)).toBe(expected);
  });

  it('reads today from the context, and nothing else', () => {
    const overdue = lt(date('2026-09-01'), today());
    expect(result(overdue, {}, { today: '2026-09-13' })).toBe(true);
    expect(result(overdue, {}, { today: '2026-08-01' })).toBe(false);
    expect(result(overdue)).toBeUndefined();
  });

  it('is unknown for a literal that does not parse, rather than guessing', () => {
    expect(evaluateExpression(num('abc'), scope())).toBeUndefined();
    expect(evaluateExpression(date('soon'), scope())).toBeUndefined();
  });

  it('is unknown for mismatched types reaching it at runtime', () => {
    expect(result(eq(text('1'), num('1')))).toBeUndefined();
  });

  it('tests multi-select membership, unknown when unanswered', () => {
    const faults: RuleValue = { type: 'options', value: ['leak', 'noise'] };
    expect(result(includes('faults', 'leak'), { faults })).toBe(true);
    expect(result(includes('faults', 'heat'), { faults })).toBe(false);
    expect(result(includes('faults', 'leak'))).toBeUndefined();
  });
});

describe('arithmetic', () => {
  const value = (expression: Expression, values: Record<string, RuleValue> = {}) =>
    evaluateExpression(expression, scope(values));
  const decimalText = (expression: Expression) => {
    const out = value(expression);
    return out?.type === 'number' ? `${String(out.value.units)}e-${String(out.value.scale)}` : out;
  };

  it('adds, subtracts, multiplies and divides exactly', () => {
    expect(decimalText(plus(num('0.1'), num('0.2')))).toBe('3e-1');
    expect(decimalText(minus(num('1'), num('0.01')))).toBe('99e-2');
    expect(decimalText(times(num('1.5'), num('4')))).toBe('60e-1');
    expect(decimalText(over(num('1'), num('4')))).toBe('250000000000e-12');
  });

  it('has no value dividing by zero, or with an unknown operand', () => {
    expect(value(over(num('1'), num('0')))).toBeUndefined();
    expect(value(plus(num('1'), UNKNOWN))).toBeUndefined();
  });

  it('keeps a chain of multiplications from growing without bound', () => {
    let product: Expression = num('1.123456');
    for (let step = 0; step < 5; step += 1) {
      product = times(product, num('1.123456'));
    }
    const out = value(product);
    expect(out?.type === 'number' && out.value.scale).toBeLessThanOrEqual(12);
  });
});

describe('reading stored answers', () => {
  it.each([
    [field('text', 't'), 'hello', { type: 'text', value: 'hello' }],
    [field('rating', 'r'), 4, { type: 'number', value: { units: BigInt(4), scale: 0 } }],
    [field('decimal', 'd'), '1.50', { type: 'number', value: { units: BigInt(150), scale: 2 } }],
    [field('time', 'at'), '01:30', { type: 'time', value: 90 }],
    [field('datetime', 'dt'), '1970-01-01T00:01Z', { type: 'datetime', value: 60 }],
    [field('multi_select', 'm'), ['a'], { type: 'options', value: ['a'] }],
    [field('checkbox', 'c'), false, { type: 'boolean', value: false }],
    [field('photo', 'p'), [photo()], { type: 'opaque' }],
    [field('gps', 'g'), { latitude: '1', longitude: '1' }, { type: 'opaque' }],
  ])('%j reads %j', (target, stored, expected) => {
    expect(toRuleValue(target, stored)).toEqual(expected);
  });

  it('reads blank, malformed and unparseable answers as unknown', () => {
    expect(toRuleValue(field('text', 't'), '')).toBeUndefined();
    expect(toRuleValue(field('number', 'n'), '4')).toBeUndefined();
    expect(toRuleValue(field('decimal', 'd'), '1.2.3')).toBeUndefined();
    expect(toRuleValue(field('date', 'd'), '2026-02-30')).toBeUndefined();
  });
});

describe('visibility across a whole form', () => {
  const inspection = compiled(
    definition([
      page('checks', [
        section('result_section', [
          field('radio', 'result', { options: options('pass', 'fail') }),
          field('text', 'reason', { visibleWhen: eq(answer('result'), text('fail')) }),
        ]),
        section(
          'follow_up',
          [
            field('checkbox', 'escalate'),
            field('text', 'ticket', { visibleWhen: answered('escalate') }),
          ],
          {
            visibleWhen: answered('reason'),
          },
        ),
      ]),
      page('sign_off', [section('signature_section', [field('signature', 'signed')])], {
        visibleWhen: ne(answer('result'), text('fail')),
      }),
    ]),
  );

  it('hides everything conditional on a blank form, and shows everything unconditional', () => {
    const { visible } = evaluateForm(inspection, {});
    expect(visible.get('result')).toBe(true);
    expect(visible.get('reason')).toBe(false);
    expect(visible.get('follow_up')).toBe(false);
    // "not fail" is unknown while result is blank, and unknown means hidden.
    expect(visible.get('sign_off')).toBe(false);
    expect(visible.get('signed')).toBe(false);
  });

  it('cascades: an answer reveals a field, which reveals a section, which reveals its fields', () => {
    const { visible } = evaluateForm(inspection, {
      result: 'fail',
      reason: 'Seal perished',
      escalate: true,
    });
    expect(visible.get('reason')).toBe(true);
    expect(visible.get('follow_up')).toBe(true);
    expect(visible.get('escalate')).toBe(true);
    expect(visible.get('ticket')).toBe(true);
    expect(visible.get('sign_off')).toBe(false);
  });

  it('treats the answer to a newly hidden field as absent, all the way down the cascade', () => {
    // The engineer chose Fail, explained why, escalated — then changed to Pass.
    const { visible, values } = evaluateForm(inspection, {
      result: 'pass',
      reason: 'Seal perished',
      escalate: true,
    });

    expect(visible.get('reason')).toBe(false);
    expect(values.has('reason')).toBe(false);
    // `reason` is hidden, so it is unanswered as far as follow_up is concerned.
    expect(visible.get('follow_up')).toBe(false);
    expect(visible.get('ticket')).toBe(false);
    expect(values.has('escalate')).toBe(false);
    expect(visible.get('sign_off')).toBe(true);
  });

  it('carries a well-formed but unreadable answer as a value, so validation can explain it', () => {
    const form = compiled(fields(field('decimal', 'pressure')));
    expect(evaluateForm(form, { pressure: '1.2.3' }).values.get('pressure')).toBe('1.2.3');
    expect(evaluateForm(form, { pressure: 12 }).values.has('pressure')).toBe(false);
  });

  it('ignores answers to ids the form does not have, including inherited ones', () => {
    // `constructor` is a valid id and also sits on every object's prototype, so a
    // lookup with `in` or `answers[id]` alone would find a function there.
    const form = compiled(fields(field('text', 'constructor')));
    expect(evaluateForm(form, {}).values.has('constructor')).toBe(false);
  });
});

describe('calculated fields', () => {
  const quote = compiled(
    fields(
      field('decimal', 'hours', { decimalPlaces: 2 }),
      field('decimal', 'rate', { decimalPlaces: 2 }),
      field('checkbox', 'callout'),
      field('decimal', 'callout_fee', {
        decimalPlaces: 2,
        visibleWhen: eq(answer('callout'), bool(true)),
      }),
      field('decimal', 'labour', {
        decimalPlaces: 2,
        calculation: times(answer('hours'), answer('rate')),
      }),
      field('number', 'labour_rounded', { calculation: answer('labour') }),
      field('decimal', 'per_hour', {
        decimalPlaces: 2,
        calculation: over(answer('labour'), answer('hours')),
      }),
    ),
  );

  it('computes exactly, at the field’s own decimal places', () => {
    const { values } = evaluateForm(quote, { hours: '2.25', rate: '45.10' });
    expect(values.get('labour')).toBe('101.48'); // 101.475, half away from zero
    expect(values.get('labour_rounded')).toBe(101);
    expect(values.get('per_hour')).toBe('45.10');
  });

  it('has no value while an input is blank, or when dividing by zero', () => {
    expect(evaluateForm(quote, { hours: '2' }).values.has('labour')).toBe(false);
    expect(evaluateForm(quote, { hours: '0', rate: '10' }).values.has('per_hour')).toBe(false);
  });

  it('refuses to produce a whole number beyond the safe integer range', () => {
    const huge = compiled(
      fields(
        field('number', 'big', { calculation: times(num('99999999999'), num('99999999999')) }),
      ),
    );
    expect(evaluateForm(huge, {}).values.has('big')).toBe(false);
  });

  it('ignores a value stored for a calculated field, and computes its own', () => {
    expect(
      evaluateForm(quote, { hours: '1', rate: '1', labour: '999.00' }).values.get('labour'),
    ).toBe('1.00');
  });

  it('reads a hidden input as absent', () => {
    const withFee = compiled(
      fields(
        field('checkbox', 'callout'),
        field('decimal', 'fee', {
          decimalPlaces: 2,
          visibleWhen: eq(answer('callout'), bool(true)),
        }),
        field('decimal', 'charged', {
          decimalPlaces: 2,
          calculation: plus(answer('fee'), num('0')),
        }),
      ),
    );
    expect(evaluateForm(withFee, { callout: true, fee: '35.00' }).values.get('charged')).toBe(
      '35.00',
    );
    expect(evaluateForm(withFee, { callout: false, fee: '35.00' }).values.has('charged')).toBe(
      false,
    );
  });
});
