import {
  compileDefinition,
  evaluateForm,
  type Expression,
  type FormDefinition,
} from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { formulaSources, parseFormula, printFormula, suggestionsAt } from './formula';

const definition: FormDefinition = {
  schemaVersion: 2,
  title: { en: 'Service' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'main',
          fields: [
            { id: 'hours', type: 'number', label: { en: 'Hours', ar: 'الساعات' } },
            { id: 'rate', type: 'decimal', decimalPlaces: 2, label: { en: 'Rate', ar: 'السعر' } },
            { id: 'travel', type: 'number', label: { en: 'Travel' } },
            { id: 'serviced', type: 'date', label: { en: 'Serviced on' } },
            { id: 'start', type: 'time', label: { en: 'Start' } },
            { id: 'finish', type: 'time', label: { en: 'Finish' } },
            { id: 'arrived', type: 'datetime', label: { en: 'Arrived' } },
            { id: 'twin_a', type: 'number', label: { en: 'Reading' } },
            { id: 'twin_b', type: 'number', label: { en: 'Reading' } },
            { id: 'notes', type: 'text', label: { en: 'Notes' } },
            { id: 'total', type: 'decimal', decimalPlaces: 2, label: { en: 'Total' } },
          ],
        },
        {
          id: 'radiators',
          title: { en: 'Radiators' },
          repeat: { maxEntries: 10, entryLabel: { en: 'Radiator' } },
          fields: [{ id: 'output', type: 'number', label: { en: 'Output' } }],
        },
      ],
    },
  ],
};

const sources = formulaSources(definition, 'total');
const parse = (text: string, expected?: 'number' | 'date') =>
  parseFormula(text, sources, 'en', expected);
const answer = (field: string): Expression => ({ kind: 'answer', field });
const num = (value: string): Expression => ({ kind: 'number', value });
const op = (
  operator: 'add' | 'subtract' | 'multiply' | 'divide',
  left: Expression,
  right: Expression,
): Expression => ({ kind: 'arithmetic', operator, left, right });

describe('the formula editor’s language', () => {
  it('reads questions by wording, numbers and the usual order of operations', () => {
    expect(parse('[Hours] + [Travel] * [Rate]')).toEqual({
      ok: true,
      type: 'number',
      expression: op('add', answer('hours'), op('multiply', answer('travel'), answer('rate'))),
    });
    expect(parse('([Hours] + [Travel]) × [Rate]')).toMatchObject({
      expression: op('multiply', op('add', answer('hours'), answer('travel')), answer('rate')),
    });
    expect(parse('-2.50 * [Hours] - -1')).toMatchObject({
      expression: op('subtract', op('multiply', num('-2.50'), answer('hours')), num('-1')),
    });
  });

  it('reads Arabic wording and Arabic-Indic digits', () => {
    expect(parseFormula('[الساعات] × ٢٫٥', sources, 'ar')).toMatchObject({
      ok: true,
      expression: op('multiply', answer('hours'), num('2.5')),
    });
  });

  it('reads every function into the engine’s nodes', () => {
    expect(parse('round([Rate] / 3, 2)')).toMatchObject({
      expression: { kind: 'round', places: 2 },
    });
    expect(parse('percent([Hours], [Travel])')).toMatchObject({
      expression: { kind: 'percentage' },
    });
    expect(parse('average([Hours], [Travel], 4)')).toMatchObject({
      expression: { kind: 'statistic', operator: 'average' },
    });
    expect(parse('hours([Start], [Finish])')).toMatchObject({
      expression: { kind: 'difference', unit: 'hours' },
    });
    expect(parse('minutes([Arrived], now)')).toMatchObject({
      expression: { kind: 'difference', unit: 'minutes', to: { kind: 'now' } },
    });
    expect(parse('days(today(), [Serviced on])')).toMatchObject({ type: 'number' });
    expect(parse('add_months([Serviced on], 12)', 'date')).toMatchObject({
      type: 'date',
      expression: { kind: 'shift_date', operator: 'add', unit: 'months' },
    });
    expect(parse('subtract_weeks("2026-01-31", 2)', 'date')).toMatchObject({
      expression: { kind: 'shift_date', operator: 'subtract', date: { kind: 'date' } },
    });
    expect(parse('count([Radiators]) + sum([Radiators], [Output])')).toMatchObject({
      expression: {
        left: { kind: 'count', section: 'radiators' },
        right: { kind: 'aggregate', operator: 'sum', field: 'output' },
      },
    });
    expect(parse('max([Radiators], [Output])')).toMatchObject({
      expression: { kind: 'aggregate', operator: 'max' },
    });
    expect(parse('[twin_a] + [twin_b]')).toMatchObject({ ok: true });
  });

  it('says what is wrong, specifically', () => {
    const problem = (text: string, expected?: 'number' | 'date') => {
      const result = parse(text, expected);
      return result.ok ? undefined : result.problem;
    };
    expect(problem('')).toEqual({ code: 'empty' });
    expect(problem('[Hours')).toEqual({ code: 'unclosed_reference', at: 0 });
    expect(problem('[Hours] +')).toMatchObject({ code: 'syntax' });
    expect(problem('[Hourz]')).toEqual({ code: 'unknown_name', name: 'Hourz' });
    expect(problem('[Reading]')).toEqual({ code: 'ambiguous_name', name: 'Reading' });
    expect(problem('[Notes]')).toEqual({ code: 'unknown_name', name: 'Notes' });
    expect(problem('sqrt(4)')).toEqual({ code: 'unknown_function', name: 'sqrt' });
    expect(problem('round([Hours])')).toEqual({ code: 'arguments', name: 'round' });
    expect(problem('round([Hours], 9)')).toEqual({ code: 'places', maximum: 6 });
    expect(problem('[Serviced on] + 1')).toEqual({
      code: 'needs',
      expected: 'number',
      found: 'date',
    });
    expect(problem('days([Start], [Serviced on])')).toEqual({
      code: 'mixed',
      left: 'time',
      right: 'date',
    });
    expect(problem('days([Start], [Finish])')).toEqual({ code: 'time_in_days' });
    expect(problem('[Hours]', 'date')).toEqual({
      code: 'result',
      expected: 'date',
      found: 'number',
    });
    expect(problem('count([Hours])')).toEqual({ code: 'not_a_section', name: 'Hours' });
    expect(problem('"soon"')).toEqual({ code: 'literal', text: 'soon' });
  });

  it('prints any calculation back to text that reads into the same tree', () => {
    const texts = [
      '[Hours] * [Rate] + 25',
      '([Hours] + [Travel]) * [Rate]',
      '[Hours] - ([Travel] - 1)',
      '[Hours] / ([Travel] / 2)',
      '-3 * [Hours] - -1',
      'round(percent([Hours], [Travel]), 1)',
      'min([Hours], [Travel], 7)',
      'hours([Start], [Finish])',
      'minutes([Arrived], now)',
      'count([Radiators]) * sum([Radiators], [Output])',
      'days(today, [Serviced on])',
      '[twin_a] + [twin_b]',
    ];
    for (const text of texts) {
      const first = parse(text);
      expect(first.ok, text).toBe(true);
      if (!first.ok) {
        continue;
      }
      const printed = printFormula(first.expression, definition, 'en')!;
      expect(printed, text).toBe(text);
      expect(parse(printed)).toEqual(first);
    }
    const date = parse('add_months([Serviced on], 12)', 'date');
    expect(date.ok && printFormula(date.expression, definition, 'en')).toBe(
      'add_months([Serviced on], 12)',
    );
  });

  it('opens a calculation from the old step-by-step editor meaning exactly what it did', () => {
    // "Hours + Travel × Rate", worked out left to right: (Hours + Travel) × Rate.
    const chain = op('multiply', op('add', answer('hours'), answer('travel')), answer('rate'));
    const text = printFormula(chain, definition, 'en')!;
    expect(text).toBe('([Hours] + [Travel]) * [Rate]');
    const reread = parse(text);
    expect(reread.ok && reread.expression).toEqual(chain);

    const withTotal: FormDefinition = {
      ...definition,
      pages: [
        {
          ...definition.pages[0]!,
          sections: [
            {
              ...definition.pages[0]!.sections[0]!,
              fields: definition.pages[0]!.sections[0]!.fields.map((field) =>
                field.id === 'total' && reread.ok
                  ? { ...field, calculation: reread.expression }
                  : field,
              ),
            },
            definition.pages[0]!.sections[1]!,
          ],
        },
      ],
    };
    const compiled = compileDefinition(withTotal);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(
        evaluateForm(compiled.form, { hours: 2, travel: 1, rate: '10.00' }).values.get('total'),
      ).toBe('30.00');
    }
  });

  it('cannot print what is not a calculation', () => {
    expect(
      printFormula(
        { kind: 'compare', operator: 'eq', left: num('1'), right: num('1') },
        definition,
        'en',
      ),
    ).toBeUndefined();
  });

  it('suggests questions after "[" and functions while a name is typed', () => {
    expect(suggestionsAt('round([Tra', 10, sources, 'en')).toEqual([
      { label: 'Travel', insert: '[Travel]', from: 6 },
    ]);
    expect(suggestionsAt('[Ra', 3, sources, 'en').map((item) => item.label)).toEqual([
      'Rate',
      'Radiators',
      'Travel',
    ]);
    expect(suggestionsAt('add_m', 5, sources, 'en')).toEqual([
      { label: 'add_months', insert: 'add_months(, 1)', from: 0 },
    ]);
    expect(suggestionsAt('[Hours] ', 8, sources, 'en')).toEqual([]);
  });
});
