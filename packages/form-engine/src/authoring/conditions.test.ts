import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileDefinition } from '../compile.js';
import { evaluateForm } from '../evaluate.js';
import type { Expression } from '../expression.js';
import type { Field } from '../field-types.js';
import { answer, field, fields, options, text } from '../test-support/builders.js';
import {
  canCompareWithField,
  clauseProblem,
  type ConditionClause,
  type ConditionModel,
  fromExpression,
  operatorsFor,
  takesValue,
  toExpression,
} from './conditions.js';

const FIELDS: Field[] = [
  field('radio', 'result', { options: options('pass', 'fail') }),
  field('yes_no', 'safe'),
  field('text', 'contact'),
  field('number', 'readings'),
  field('decimal', 'pressure', { decimalPlaces: 1 }),
  field('date', 'installed'),
  field('time', 'arrived'),
  field('time', 'left'),
  field('datetime', 'logged'),
  field('multi_select', 'hazards', { options: options('height', 'electrics') }),
  field('checkbox', 'isolated'),
  field('photo', 'evidence'),
  field('long_text', 'notes'),
];

const lookup = (id: string) => FIELDS.find((candidate) => candidate.id === id);

const model = (match: 'all' | 'any', ...clauses: ConditionClause[]): ConditionModel => ({
  match,
  clauses,
});

describe('which operators a field offers', () => {
  it.each([
    ['result', ['is', 'is_not', 'is_answered', 'is_not_answered']],
    [
      'readings',
      [
        'is',
        'is_not',
        'is_greater_than',
        'is_less_than',
        'is_at_least',
        'is_at_most',
        'is_answered',
        'is_not_answered',
      ],
    ],
    [
      'installed',
      [
        'is',
        'is_before',
        'is_after',
        'is_before_today',
        'is_after_today',
        'is_answered',
        'is_not_answered',
      ],
    ],
    ['arrived', ['is', 'is_before', 'is_after', 'is_answered', 'is_not_answered']],
    ['hazards', ['includes', 'does_not_include', 'is_answered', 'is_not_answered']],
    ['isolated', ['is_checked', 'is_not_checked']],
    ['evidence', ['is_answered', 'is_not_answered']],
  ])('%s offers %j', (id, expected) => {
    expect(operatorsFor(lookup(id)!)).toEqual(expected);
  });

  it('knows which operators need a value, and which can compare two answers', () => {
    expect(takesValue('is')).toBe(true);
    expect(takesValue('is_checked')).toBe(false);
    expect(takesValue('is_before_today')).toBe(false);
    expect(canCompareWithField('is_after')).toBe(true);
    expect(canCompareWithField('includes')).toBe(false);
  });
});

describe('clauses into rules', () => {
  it('stores no condition at all for no clauses', () => {
    expect(toExpression(model('all'), lookup)).toBeUndefined();
    expect(fromExpression(undefined, lookup)).toEqual(model('all'));
  });

  it('writes one clause as that comparison alone, with a literal of the field’s own kind', () => {
    expect(
      toExpression(model('all', { field: 'result', operator: 'is', value: 'fail' }), lookup),
    ).toEqual(eq('result', text('fail')));
    expect(
      toExpression(
        model('all', { field: 'readings', operator: 'is_greater_than', value: '5' }),
        lookup,
      ),
    ).toEqual({
      kind: 'compare',
      operator: 'gt',
      left: answer('readings'),
      right: { kind: 'number', value: '5' },
    });
    expect(
      toExpression(
        model('all', { field: 'installed', operator: 'is_before', value: '2020-01-01' }),
        lookup,
      ),
    ).toMatchObject({
      right: { kind: 'date', value: '2020-01-01' },
    });
  });

  it('joins several clauses with all or any', () => {
    const expression = toExpression(
      model(
        'any',
        { field: 'result', operator: 'is', value: 'fail' },
        { field: 'isolated', operator: 'is_not_checked' },
      ),
      lookup,
    );
    expect(expression?.kind).toBe('any');
  });

  it('compares one answer with another', () => {
    expect(
      toExpression(
        model('all', { field: 'left', operator: 'is_after', valueField: 'arrived' }),
        lookup,
      ),
    ).toEqual({
      kind: 'compare',
      operator: 'gt',
      left: answer('left'),
      right: answer('arrived'),
    });
  });

  it('drops a clause whose field no longer exists rather than writing a broken rule', () => {
    expect(
      toExpression(model('all', { field: 'deleted', operator: 'is_answered' }), lookup),
    ).toBeUndefined();
  });
});

describe('what the words mean on a real form', () => {
  const shown = (clause: ConditionClause, answers: Record<string, unknown>) => {
    const definition = fields(
      ...FIELDS,
      field('text', 'target', { visibleWhen: toExpression(model('all', clause), lookup)! }),
    );
    const compiled = compileDefinition(definition);
    if (!compiled.ok) throw new Error(compiled.issues.map((issue) => issue.message).join('; '));
    return evaluateForm(compiled.form, answers, { today: '2026-09-13' }).visible.get('target');
  };

  it('"is not checked" means unticked or never touched, as a person means it', () => {
    const clause: ConditionClause = { field: 'isolated', operator: 'is_not_checked' };
    expect(shown(clause, {})).toBe(true);
    expect(shown(clause, { isolated: false })).toBe(true);
    expect(shown(clause, { isolated: true })).toBe(false);
  });

  it('"is checked" is only true when ticked', () => {
    expect(shown({ field: 'isolated', operator: 'is_checked' }, {})).toBe(false);
    expect(shown({ field: 'isolated', operator: 'is_checked' }, { isolated: true })).toBe(true);
  });

  it('relative to today uses the date the form is filled', () => {
    expect(
      shown({ field: 'installed', operator: 'is_before_today' }, { installed: '2026-09-01' }),
    ).toBe(true);
    expect(
      shown({ field: 'installed', operator: 'is_after_today' }, { installed: '2026-09-01' }),
    ).toBe(false);
  });

  it('includes and does not include test a multi-select', () => {
    expect(
      shown({ field: 'hazards', operator: 'includes', value: 'height' }, { hazards: ['height'] }),
    ).toBe(true);
    expect(
      shown(
        { field: 'hazards', operator: 'does_not_include', value: 'height' },
        { hazards: ['electrics'] },
      ),
    ).toBe(true);
  });

  it('every operator on every field compiles into a rule the engine accepts', () => {
    const sample: Record<string, string | undefined> = {
      result: 'pass',
      safe: 'yes',
      contact: 'Dana',
      readings: '3',
      pressure: '1.5',
      installed: '2026-01-01',
      arrived: '09:00',
      left: '10:00',
      logged: '2026-01-01T09:00Z',
      hazards: 'height',
      isolated: undefined,
      evidence: undefined,
      notes: 'x',
    };
    for (const target of FIELDS) {
      for (const operator of operatorsFor(target)) {
        const clause: ConditionClause = {
          field: target.id,
          operator,
          ...(takesValue(operator) ? { value: sample[target.id] ?? '' } : {}),
        };
        expect(clauseProblem(clause, lookup), `${target.id} ${operator}`).toBeUndefined();
        const definition = fields(
          ...FIELDS,
          field('text', 'target', { visibleWhen: toExpression(model('all', clause), lookup)! }),
        );
        expect(compileDefinition(definition).ok, `${target.id} ${operator}`).toBe(true);
      }
    }
  });
});

describe('rules back into clauses', () => {
  const clauseArbitrary: fc.Arbitrary<ConditionClause> = fc
    .tuple(fc.constantFrom(...FIELDS), fc.nat(), fc.nat())
    .map(([target, operatorChoice, compareChoice]) => {
      const operators = operatorsFor(target);
      const operator = operators[operatorChoice % operators.length]!;
      if (!takesValue(operator)) {
        return { field: target.id, operator };
      }
      const same = FIELDS.filter((other) => other.id !== target.id && other.type === target.type);
      if (canCompareWithField(operator) && same.length > 0 && compareChoice % 3 === 0) {
        return { field: target.id, operator, valueField: same[compareChoice % same.length]!.id };
      }
      const value: Record<string, string> = {
        result: 'fail',
        safe: 'no',
        contact: 'x',
        readings: '7',
        pressure: '2.5',
        installed: '2026-02-03',
        arrived: '08:30',
        left: '17:00',
        logged: '2026-01-01T09:00+02:00',
        hazards: 'electrics',
        notes: 'y',
      };
      return { field: target.id, operator, value: value[target.id] ?? 'x' };
    });

  it('reads back exactly the clauses that were written, for any combination', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('all' as const, 'any' as const),
        fc.array(clauseArbitrary, { maxLength: 6 }),
        (match, clauses) => {
          const written = toExpression({ match, clauses }, lookup);
          const read = fromExpression(written, lookup);
          const expected = clauses.length <= 1 ? { match: 'all', clauses } : { match, clauses };
          expect(read).toEqual(expected);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('refuses to turn an expression it could not have built into clauses', () => {
    const unreadable: Expression[] = [
      { kind: 'not', operand: eq('result', text('fail')) },
      { kind: 'all', operands: [{ kind: 'any', operands: [eq('result', text('fail'))] }] },
      { kind: 'compare', operator: 'eq', left: text('fail'), right: answer('result') },
      { kind: 'compare', operator: 'gt', left: answer('result'), right: text('a') },
      {
        kind: 'compare',
        operator: 'le',
        left: answer('installed'),
        right: { kind: 'date', value: '2026-01-01' },
      },
      { kind: 'compare', operator: 'eq', left: answer('installed'), right: { kind: 'today' } },
      { kind: 'compare', operator: 'eq', left: answer('readings'), right: text('5') },
      { kind: 'compare', operator: 'eq', left: answer('ghost'), right: text('5') },
      {
        kind: 'compare',
        operator: 'eq',
        left: answer('isolated'),
        right: { kind: 'boolean', value: false },
      },
      {
        kind: 'arithmetic',
        operator: 'add',
        left: answer('readings'),
        right: { kind: 'number', value: '1' },
      },
      { kind: 'boolean', value: true },
    ];
    for (const expression of unreadable) {
      expect(fromExpression(expression, lookup), JSON.stringify(expression)).toBeUndefined();
    }
  });
});

describe('problems beside the clause', () => {
  it.each([
    [{ field: 'ghost', operator: 'is_answered' }, 'unknown_field'],
    [{ field: 'isolated', operator: 'is' }, 'operator_not_allowed'],
    [{ field: 'contact', operator: 'is' }, 'value_required'],
    [{ field: 'result', operator: 'is', value: 'fial' }, 'unknown_option'],
    [{ field: 'hazards', operator: 'includes', value: 'fire' }, 'unknown_option'],
    [{ field: 'readings', operator: 'is_greater_than', value: 'five' }, 'value_invalid'],
    [{ field: 'installed', operator: 'is_before', value: '01/02/2026' }, 'value_invalid'],
    [{ field: 'arrived', operator: 'is', value: '9am' }, 'value_invalid'],
    [{ field: 'logged', operator: 'is', value: '2026-01-01T09:00' }, 'value_invalid'],
    [{ field: 'left', operator: 'is_after', valueField: 'ghost' }, 'compared_field_unknown'],
    [{ field: 'left', operator: 'is_after', valueField: 'installed' }, 'compared_field_mismatch'],
  ] as [ConditionClause, string][])('%j is %s', (clause, problem) => {
    expect(clauseProblem(clause, lookup)).toBe(problem);
  });

  it('accepts a well-formed clause', () => {
    expect(
      clauseProblem({ field: 'left', operator: 'is_after', valueField: 'arrived' }, lookup),
    ).toBeUndefined();
    expect(
      clauseProblem({ field: 'contact', operator: 'is', value: 'Dana' }, lookup),
    ).toBeUndefined();
  });
});

function eq(field: string, right: Expression): Expression {
  return { kind: 'compare', operator: 'eq', left: answer(field), right };
}
