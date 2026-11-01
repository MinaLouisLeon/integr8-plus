import { describe, expect, it } from 'vitest';
import { compileDefinition } from './compile.js';
import { requiredSchemaVersion, withRequiredSchemaVersion } from './definition.js';
import { evaluateForm } from './evaluate.js';
import { fieldsOf, findField, findItem, referencesTo, duplicate } from './authoring/editing.js';
import { diffDefinitions } from './authoring/diff.js';
import { reportableFields } from './reporting.js';
import { createFormState, toSubmission, transition, viewForm } from './state.js';
import { formatDate, parseDate, shiftDays } from './temporal.js';
import {
  answer,
  compiled,
  date,
  datetime,
  definition,
  difference,
  eq,
  field,
  fields,
  information,
  issuesOf,
  label,
  lt,
  now,
  num,
  options,
  over,
  page,
  percentage,
  plus,
  round,
  section,
  shiftDate,
  statistic,
  text,
  time,
  times,
  today,
} from './test-support/builders.js';
import { validateSubmission } from './validation.js';

/** What a calculated decimal question works out to, for these answers. */
function decimalOf(
  calculation: ReturnType<typeof num>,
  answers: Record<string, unknown> = {},
  context: { today?: string; now?: string } = {},
  places = 6,
  extra: ReturnType<typeof field>[] = [],
) {
  const form = compiled(
    fields(...extra, field('decimal', 'result', { decimalPlaces: places, calculation })),
  );
  return evaluateForm(form, answers, context).values.get('result');
}

function dateOf(
  calculation: ReturnType<typeof num>,
  answers: Record<string, unknown> = {},
  extra: ReturnType<typeof field>[] = [],
) {
  const form = compiled(fields(...extra, field('date', 'result', { calculation })));
  return evaluateForm(form, answers).values.get('result');
}

describe('schema version 2: which format a definition needs', () => {
  it('keeps a form that uses none of the additions at version 1', () => {
    const plain = fields(
      field('number', 'a'),
      field('number', 'b', { calculation: plus(answer('a'), num('1')) }),
    );
    expect(plain.schemaVersion).toBe(1);
    expect(requiredSchemaVersion(plain)).toBe(1);
  });

  it('needs version 2 for a description, an Information block or a version 2 calculation', () => {
    expect(
      requiredSchemaVersion(
        definition([page('p', [section('s', [field('text', 't')])], { description: label('Hi') })]),
      ),
    ).toBe(2);
    expect(
      requiredSchemaVersion(
        definition([page('p', [section('s', [field('text', 't')], { description: label('Hi') })])]),
      ),
    ).toBe(2);
    expect(requiredSchemaVersion(fields(information('note')))).toBe(2);
    expect(
      requiredSchemaVersion(fields(field('decimal', 'd', { calculation: round(num('1.25'), 1) }))),
    ).toBe(2);
    expect(requiredSchemaVersion(fields(field('date', 'd', { calculation: today() })))).toBe(2);
    expect(
      requiredSchemaVersion(
        fields(
          field('date', 'd'),
          field('text', 't', {
            visibleWhen: lt(answer('d'), shiftDate('add', 'days', today(), num('1'))),
          }),
        ),
      ),
    ).toBe(2);
  });

  it('reads a half-built draft as it is, and leaves anything else alone', () => {
    expect(
      requiredSchemaVersion({ pages: [{ sections: [{ fields: [{ type: 'information' }] }] }] }),
    ).toBe(2);
    expect(requiredSchemaVersion('nonsense')).toBe(1);
    expect(withRequiredSchemaVersion('nonsense')).toBe('nonsense');
    const draft = { schemaVersion: 1, pages: [{ description: { en: 'x' } }] };
    expect(withRequiredSchemaVersion(draft)).toEqual({ ...draft, schemaVersion: 2 });
    const already = { schemaVersion: 1, pages: [] };
    expect(withRequiredSchemaVersion(already)).toBe(already);
  });

  it('refuses a definition that declares less than it uses, so older apps are told before they try', () => {
    const declared = { ...fields(information('note')), schemaVersion: 1 };
    expect(issuesOf(declared)).toEqual([
      expect.objectContaining({ code: 'schema_version_too_low', path: 'schemaVersion' }),
    ]);
  });

  it('accepts a version 2 definition that happens to use nothing new', () => {
    expect(compileDefinition({ ...fields(field('text', 't')), schemaVersion: 2 }).ok).toBe(true);
  });
});

describe('Information blocks', () => {
  const form = () =>
    compiled(
      fields(
        field('radio', 'result', { options: options('pass', 'fail') }),
        information('isolate', {
          heading: label('Before you start'),
          body: label('Isolate the supply.\nCheck it is dead.'),
          style: 'warning',
          visibleWhen: eq(answer('result'), text('fail')),
        }),
        field('text', 'notes'),
      ),
    );

  it('is placed among the questions but is not one', () => {
    const compiledForm = form();
    expect(compiledForm.fields.map((candidate) => candidate.id)).toEqual(['result', 'notes']);
    expect(compiledForm.elements.get('isolate')).toMatchObject({
      kind: 'information',
      field: undefined,
      parent: 'section_1',
    });
    expect(compiledForm.elements.get('isolate')?.information?.style).toBe('warning');
  });

  it('follows "Shown when" and never has a value', () => {
    const compiledForm = form();
    const hidden = evaluateForm(compiledForm, { result: 'pass' });
    expect(hidden.visible.get('isolate')).toBe(false);
    const shown = evaluateForm(compiledForm, { result: 'fail' });
    expect(shown.visible.get('isolate')).toBe(true);
    expect(shown.values.has('isolate')).toBe(false);
  });

  it('is not answered, submitted, counted or reported', () => {
    const compiledForm = form();
    let state = createFormState(compiledForm);
    state = transition(compiledForm, state, {
      type: 'answer',
      field: 'result',
      value: 'fail',
    }).state;
    expect(toSubmission(compiledForm, state)).toEqual({ result: 'fail' });
    expect(viewForm(compiledForm, state).progress.total).toBe(2);
    expect(
      transition(compiledForm, state, { type: 'answer', field: 'isolate', value: 'x' }).accepted,
    ).toBe(false);
    expect(validateSubmission(compiledForm, { result: 'fail', isolate: 'x' }).issues).toEqual([
      { code: 'unknown_field', field: 'isolate' },
    ]);
    expect(reportableFields(compiledForm.definition).map((entry) => entry.field)).toEqual([
      'result',
      'notes',
    ]);
  });

  it('cannot be read by a rule', () => {
    expect(
      issuesOf(
        fields(
          information('note'),
          field('text', 't', { visibleWhen: eq(answer('note'), text('x')) }),
        ),
      ),
    ).toEqual([expect.objectContaining({ code: 'not_a_field', elements: ['note'] })]);
  });

  it('is shown per entry inside a repeatable section', () => {
    const compiledForm = compiled(
      definition([
        page('p', [
          section(
            'rads',
            [
              field('yes_no', 'leak'),
              information('drain', { visibleWhen: eq(answer('leak'), text('yes')) }),
            ],
            { repeat: { maxEntries: 5, entryLabel: label('Radiator') } },
          ),
        ]),
      ]),
    );
    const evaluation = evaluateForm(compiledForm, {
      rads: [
        { id: 'a', values: { leak: 'yes' } },
        { id: 'b', values: { leak: 'no' } },
      ],
    });
    expect(evaluation.entries.get('rads')?.map((entry) => entry.visible.get('drain'))).toEqual([
      true,
      false,
    ]);
    expect(evaluation.values.get('rads')).toEqual([
      { id: 'a', values: { leak: 'yes' } },
      { id: 'b', values: { leak: 'no' } },
    ]);
  });

  it('moves, duplicates and is found like a question, but is not a question', () => {
    const start = fields(
      field('text', 'a'),
      information('note', { visibleWhen: eq(answer('a'), text('x')) }),
    );
    expect(findField(start, 'note')).toBeUndefined();
    expect(findItem(start, 'note')?.type).toBe('information');
    expect(fieldsOf(start).map((candidate) => candidate.id)).toEqual(['a']);
    expect(referencesTo(start, ['a'])).toEqual([{ from: 'note', where: 'visibleWhen', to: 'a' }]);
    const copied = duplicate(start, 'note');
    expect(
      'definition' in copied &&
        copied.definition.pages[0]!.sections[0]!.fields.map((item) => item.id),
    ).toEqual(['a', 'note', 'note_copy']);
  });

  it('tells a question replaced by a block from one that changed', () => {
    const before = fields(field('text', 'note'));
    const after = fields(information('note'));
    expect(diffDefinitions(before, after).breaking).toEqual([
      { field: 'note', reason: 'field_removed', affects: 'reporting', detail: [] },
    ]);
  });
});

describe('number extras', () => {
  it('rounds half away from zero to the places asked', () => {
    expect(decimalOf(round(num('2.345'), 2))).toBe('2.350000');
    expect(decimalOf(round(num('-2.345'), 2))).toBe('-2.350000');
    expect(decimalOf(round(num('2.344'), 0), {}, {}, 0)).toBe('2');
  });

  it('works out a percentage, and nothing for a whole of zero', () => {
    expect(decimalOf(percentage(num('3'), num('8')), {}, {}, 2)).toBe('37.50');
    expect(decimalOf(percentage(num('3'), num('0')))).toBeUndefined();
  });

  it('takes the least, greatest or average of the answers given, passing over blanks', () => {
    const extra = [field('decimal', 'a'), field('decimal', 'b'), field('decimal', 'c')];
    const answers = { a: '4.00', c: '1.50' };
    const of = (operator: 'min' | 'max' | 'average') =>
      decimalOf(statistic(operator, answer('a'), answer('b'), answer('c')), answers, {}, 3, extra);
    expect(of('min')).toBe('1.500');
    expect(of('max')).toBe('4.000');
    expect(of('average')).toBe('2.750');
    expect(
      decimalOf(statistic('average', answer('a'), answer('b')), {}, {}, 2, extra),
    ).toBeUndefined();
  });

  it('keeps brackets: (a + b) × c is not a + (b × c)', () => {
    const extra = [field('number', 'a'), field('number', 'b'), field('number', 'c')];
    const answers = { a: 2, b: 3, c: 4 };
    expect(
      decimalOf(times(plus(answer('a'), answer('b')), answer('c')), answers, {}, 0, extra),
    ).toBe('20');
    expect(
      decimalOf(plus(answer('a'), times(answer('b'), answer('c'))), answers, {}, 0, extra),
    ).toBe('14');
    expect(decimalOf(over(num('1'), num('3')), {}, {}, 4)).toBe('0.3333');
  });
});

describe('date and time calculations', () => {
  it('counts days between dates, whatever the clocks did', () => {
    const extra = [field('date', 'from'), field('date', 'to')];
    expect(
      decimalOf(
        difference('days', answer('from'), answer('to')),
        { from: '2026-03-25', to: '2026-04-02' },
        {},
        0,
        extra,
      ),
    ).toBe('8');
    expect(
      decimalOf(
        difference('hours', answer('from'), answer('to')),
        { from: '2026-01-02', to: '2026-01-01' },
        {},
        0,
        extra,
      ),
    ).toBe('-24');
  });

  it('counts time between two dates and times as elapsed time, offsets applied', () => {
    const extra = [field('datetime', 'arrived'), field('datetime', 'left')];
    expect(
      decimalOf(
        difference('hours', answer('arrived'), answer('left')),
        { arrived: '2026-04-24T23:30:00+02:00', left: '2026-04-25T02:00:00+03:00' },
        {},
        2,
        extra,
      ),
    ).toBe('1.50');
    expect(
      decimalOf(
        difference('minutes', answer('arrived'), now()),
        { arrived: '2026-04-24T10:00:00+03:00' },
        { now: '2026-04-24T10:45:00+03:00' },
        0,
        extra,
      ),
    ).toBe('45');
    expect(
      decimalOf(
        difference('minutes', answer('arrived'), now()),
        { arrived: '2026-04-24T10:00:00+03:00' },
        {},
        0,
        extra,
      ),
    ).toBeUndefined();
  });

  it('takes a finish time earlier on the clock than the start as the next day', () => {
    const extra = [field('time', 'start'), field('time', 'finish')];
    const hours = (start: string, finish: string) =>
      decimalOf(
        difference('hours', answer('start'), answer('finish')),
        { start, finish },
        {},
        2,
        extra,
      );
    expect(hours('08:00', '16:30')).toBe('8.50');
    expect(hours('22:00', '06:00')).toBe('8.00');
  });

  it('moves a date by days, weeks and months, keeping the day of the month where it can', () => {
    const extra = [field('date', 'serviced')];
    const moved = (
      operator: 'add' | 'subtract',
      unit: 'days' | 'weeks' | 'months',
      from: string,
      amount: string,
    ) =>
      dateOf(shiftDate(operator, unit, answer('serviced'), num(amount)), { serviced: from }, extra);
    expect(moved('add', 'months', '2026-01-31', '1')).toBe('2026-02-28');
    expect(moved('add', 'months', '2028-01-31', '1')).toBe('2028-02-29');
    expect(moved('subtract', 'months', '2026-03-31', '1')).toBe('2026-02-28');
    expect(moved('add', 'months', '2026-11-15', '14')).toBe('2028-01-15');
    expect(moved('subtract', 'months', '2026-01-15', '13')).toBe('2024-12-15');
    expect(moved('add', 'weeks', '2026-12-28', '1')).toBe('2027-01-04');
    expect(moved('subtract', 'days', '2026-03-01', '1')).toBe('2026-02-28');
    expect(moved('add', 'days', '2026-03-01', '1.5')).toBeUndefined();
    expect(moved('add', 'days', '9999-12-31', '1')).toBeUndefined();
  });

  it('gives a date a rule can compare, and a decimal amount that is whole still counts', () => {
    const form = compiled(
      fields(
        field('date', 'serviced'),
        field('decimal', 'interval', { decimalPlaces: 1 }),
        field('date', 'due', {
          calculation: shiftDate('add', 'months', answer('serviced'), answer('interval')),
        }),
        field('text', 'overdue', { visibleWhen: lt(answer('due'), today()) }),
      ),
    );
    const evaluation = evaluateForm(
      form,
      { serviced: '2025-01-10', interval: '12.0' },
      { today: '2026-02-01' },
    );
    expect(evaluation.values.get('due')).toBe('2026-01-10');
    expect(evaluation.visible.get('overdue')).toBe(true);
    expect(
      validateSubmission(
        form,
        { serviced: '2025-01-10', interval: '12.0' },
        { today: '2026-02-01' },
      ).answers,
    ).toEqual({
      serviced: '2025-01-10',
      interval: '12.0',
      due: '2026-01-10',
    });
  });

  it('refuses kinds that do not go together, at publish', () => {
    const refused = (calculation: ReturnType<typeof num>, type: 'decimal' | 'date' = 'decimal') =>
      issuesOf(
        fields(
          field('date', 'd'),
          field('time', 't'),
          field('datetime', 'dt'),
          type === 'date'
            ? field('date', 'result', { calculation })
            : field('decimal', 'result', { decimalPlaces: 2, calculation }),
        ),
      ).map((issue) => issue.code);
    expect(refused(difference('days', answer('d'), answer('dt')))).toEqual(['type_mismatch']);
    expect(refused(difference('days', answer('t'), answer('t')))).toEqual(['type_mismatch']);
    expect(refused(difference('days', num('1'), num('2')))).toEqual(['type_mismatch']);
    expect(refused(shiftDate('add', 'days', answer('dt'), num('1')), 'date')).toEqual([
      'type_mismatch',
    ]);
    expect(refused(shiftDate('add', 'days', answer('d'), text('1')), 'date')).toEqual([
      'type_mismatch',
    ]);
    expect(refused(answer('d'))).toEqual(['type_mismatch']);
    expect(refused(num('1'), 'date')).toEqual(['type_mismatch']);
    expect(refused(round(text('x'), 1))).toEqual(['type_mismatch']);
    expect(refused(percentage(text('x'), num('1')))).toEqual(['type_mismatch']);
    expect(refused(statistic('min', num('1'), text('x')))).toEqual(['type_mismatch']);
    expect(refused(eq(now(), datetime('2026-01-01T00:00:00Z')))).toEqual(['type_mismatch']);
  });

  it('knows a date calculation reads its sources, so a cycle is named', () => {
    expect(
      issuesOf(
        fields(
          field('date', 'a', { calculation: shiftDate('add', 'days', answer('b'), num('1')) }),
          field('date', 'b', { calculation: shiftDate('add', 'days', answer('a'), num('1')) }),
        ),
      ).map((issue) => issue.code),
    ).toEqual(['circular_dependency']);
  });

  it('reads literal dates and times like answers', () => {
    expect(decimalOf(difference('minutes', time('09:15'), time('10:00')), {}, {}, 0)).toBe('45');
    expect(decimalOf(difference('days', date('2024-02-28'), date('2024-03-01')), {}, {}, 0)).toBe(
      '2',
    );
  });
});

describe('formatDate and shiftDays', () => {
  it('turns a day count back into its date, across eras and leap years', () => {
    for (const text of [
      '0001-01-01',
      '1600-02-29',
      '1970-01-01',
      '2000-02-29',
      '2026-12-31',
      '9999-12-31',
    ]) {
      expect(formatDate(parseDate(text)!)).toBe(text);
    }
    expect(formatDate(parseDate('0001-01-01')! - 1)).toBeUndefined();
    expect(formatDate(1.5)).toBeUndefined();
  });

  it('agrees with itself day by day over four centuries', () => {
    const start = parseDate('1900-01-01')!;
    for (let day = start; day < start + 146_097; day += 1) {
      const text = formatDate(day)!;
      expect(parseDate(text)).toBe(day);
    }
  });

  it('refuses amounts and dates out of range', () => {
    expect(shiftDays(parseDate('2026-01-01')!, 'days', 0.5)).toBeUndefined();
    expect(shiftDays(parseDate('0001-01-15')!, 'months', -1)).toBeUndefined();
    expect(shiftDays(Number.NaN, 'days', 1)).toBeUndefined();
  });
});
