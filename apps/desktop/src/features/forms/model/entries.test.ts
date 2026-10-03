import {
  compileDefinition,
  type ConditionModel,
  diffDefinitions,
  type Expression,
  type Field,
  type FieldOf,
  type FormDefinition,
  fromExpression,
  newField,
  type Section,
} from '@integr8/form-engine';
import { createI18n } from '@integr8/i18n';
import { describe, expect, it } from 'vitest';
import { completeExpression, lookupIn } from '../components/condition-builder';
import {
  calculationSources,
  fromCalculation,
  termFromKey,
  termKey,
  toCalculation,
} from './calculation';
import { breakingText, issueText } from './issues';
import {
  limitProblem,
  titleCandidates,
  withEntryLabel,
  withLimits,
  withRepeat,
  withTitleField,
} from './repeat';
import { clauseFor, type Subject, subjectKey, subjectProblem, subjectsFor } from './subjects';

/**
 * Repeatable sections in the builder (P13b): turning repeating on and off, its
 * limits, what a condition or calculation can read from where it sits, and the
 * words for what publishing finds.
 */

const i18n = createI18n({ locale: 'en' });
const t = i18n.t.bind(i18n);

const room = newField('text', 'room', { en: 'Room' });
const watts = newField('number', 'watts', { en: 'Output' });
const result: Field = {
  id: 'result',
  type: 'radio',
  label: { en: 'Result' },
  options: [
    { value: 'pass', label: { en: 'Pass' } },
    { value: 'fail', label: { en: 'Fail' } },
  ],
};
const evidence = newField('photo', 'evidence', { en: 'Evidence' });
const site = newField('text', 'site', { en: 'Site' });
const total: FieldOf<'number'> = { id: 'total', type: 'number', label: { en: 'Total output' } };
const note = newField('text', 'note', { en: 'Note' });

const radiators: Section = {
  id: 'radiators',
  title: { en: 'Radiators' },
  repeat: { maxEntries: 20, entryLabel: { en: 'Radiator' } },
  fields: [room, watts, result, evidence],
};

function form(extra: Partial<Section> = {}, summary: Field[] = [note, total]): FormDefinition {
  return {
    schemaVersion: 1,
    title: { en: 'Heating survey' },
    pages: [
      {
        id: 'page_1',
        sections: [
          { id: 'visit', fields: [site] },
          { ...radiators, ...extra },
          { id: 'summary', fields: summary },
        ],
      },
    ],
  };
}

const compiles = (definition: FormDefinition) => {
  const compiled = compileDefinition(definition);
  return compiled.ok ? [] : compiled.issues.map((issue) => issue.code);
};

const withVisibility = (definition: FormDefinition, id: string, expression: Expression) => ({
  ...definition,
  pages: definition.pages.map((page) => ({
    ...page,
    sections: page.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        field.id === id ? { ...field, visibleWhen: expression } : field,
      ),
    })),
  })),
});

describe('repeating a section', () => {
  it('turns repeating on with room for 20, and off again without a trace', () => {
    const plain: Section = { id: 'rooms', fields: [room] };
    const on = withRepeat(plain, true, { en: 'Room' });
    expect(on.repeat).toEqual({ maxEntries: 20, entryLabel: { en: 'Room' } });
    // Turning it on again keeps what was set.
    const limited = withLimits(on, { minEntries: '1', maxEntries: '5' });
    expect(withRepeat(limited, true, { en: 'Other' })).toBe(limited);
    expect(withRepeat(limited, false, { en: 'Room' })).toEqual(plain);
  });

  it('takes limits only once they are whole numbers in range, the fewest no more than the most', () => {
    const plain: Section = { id: 'rooms', fields: [room] };
    const section = withRepeat(plain, true, { en: 'Room' });
    expect(limitProblem({ minEntries: '', maxEntries: '20' })).toBeUndefined();
    expect(limitProblem({ minEntries: '0', maxEntries: '100' })).toBeUndefined();
    expect(limitProblem({ minEntries: '101', maxEntries: '100' })).toBe('min_invalid');
    expect(limitProblem({ minEntries: '1.5', maxEntries: '10' })).toBe('min_invalid');
    expect(limitProblem({ minEntries: '', maxEntries: '0' })).toBe('max_invalid');
    expect(limitProblem({ minEntries: '', maxEntries: '' })).toBe('max_invalid');
    expect(limitProblem({ minEntries: '6', maxEntries: '5' })).toBe('min_above_max');

    // Half-typed limits leave the section as it was.
    expect(withLimits(section, { minEntries: '6', maxEntries: '5' })).toBe(section);
    const set = withLimits(section, { minEntries: '2', maxEntries: '8' });
    expect(set.repeat).toEqual({ minEntries: 2, maxEntries: 8, entryLabel: { en: 'Room' } });
    // An empty minimum means none are needed, stored as no minimum at all.
    expect(withLimits(set, { minEntries: '', maxEntries: '8' }).repeat).toEqual({
      maxEntries: 8,
      entryLabel: { en: 'Room' },
    });
    expect(compiles(form(withLimits(radiators, { minEntries: '2', maxEntries: '8' })))).toEqual([]);
  });

  it('names entries by one of the section’s short answers, numbers, dates, times or single choices', () => {
    expect(titleCandidates(radiators).map((field) => field.id)).toEqual([
      'room',
      'watts',
      'result',
    ]);
    const titled = withTitleField(radiators, 'room');
    expect(titled.repeat?.titleField).toBe('room');
    expect(compiles(form(titled))).toEqual([]);
    expect(withTitleField(titled, undefined).repeat).not.toHaveProperty('titleField');
    expect(withEntryLabel(titled, { en: 'Heater' }).repeat?.entryLabel).toEqual({ en: 'Heater' });
  });
});

describe('conditions across entries', () => {
  const names = (subjects: Subject[]) =>
    subjects.map((subject) =>
      subject.kind === 'entry_count'
        ? `count ${subject.section.id}`
        : `${subject.field.id}${subject.across === undefined ? '' : ` across ${subject.across.id}`}`,
    );

  it('offers a repeatable section’s questions from outside only across its entries, and its count', () => {
    expect(names(subjectsFor(form(), 'note'))).toEqual([
      'site',
      'count radiators',
      'room across radiators',
      'watts across radiators',
      'result across radiators',
      'evidence across radiators',
      'total',
    ]);
  });

  it('offers an entry’s own questions plainly inside it, and does not count its own section', () => {
    expect(names(subjectsFor(form(), 'result'))).toEqual([
      'site',
      'room',
      'watts',
      'evidence',
      'note',
      'total',
    ]);
  });

  it('saves a quantified clause only once it says any or every, and reads it back the same', () => {
    const definition = form();
    const lookup = lookupIn(definition);
    const subjects = subjectsFor(definition, 'note');
    const subject = subjects.find((candidate) => subjectKey(candidate) === 'result')!;

    const clause = { ...clauseFor(subject), operator: 'includes' as const };
    expect(clauseFor(subject)).toEqual({
      field: 'result',
      operator: 'is',
      entries: { section: 'radiators', quantifier: 'some' },
    });

    const model: ConditionModel = {
      match: 'all',
      clauses: [{ ...clauseFor(subject), value: 'fail' }],
    };
    const expression = completeExpression(model, lookup, subjects);
    expect(expression).toEqual({
      kind: 'some',
      section: 'radiators',
      condition: {
        kind: 'compare',
        operator: 'eq',
        left: { kind: 'answer', field: 'result' },
        right: { kind: 'text', value: 'fail' },
      },
    });
    expect(fromExpression(expression, lookup)).toEqual(model);
    expect(compiles(withVisibility(definition, 'note', expression!))).toEqual([]);

    const every: ConditionModel = {
      match: 'all',
      clauses: [{ ...model.clauses[0]!, entries: { section: 'radiators', quantifier: 'every' } }],
    };
    const everyExpression = completeExpression(every, lookup, subjects);
    expect(everyExpression?.kind).toBe('every');
    expect(fromExpression(everyExpression, lookup)).toEqual(every);

    // Without a quantifier the clause is not finished, and nothing is saved.
    const bare = { field: 'result', operator: 'is' as const, value: 'fail' };
    expect(subjectProblem(bare, lookup, subjects)).toBe('quantifier_required');
    expect(completeExpression({ match: 'all', clauses: [bare] }, lookup, subjects)).toBeUndefined();
    // Nor is one whose comparison does not apply.
    expect(subjectProblem(clause, lookup, subjects)).toBe('operator_not_allowed');
  });

  it('counts entries with a whole number', () => {
    const definition = form();
    const lookup = lookupIn(definition);
    const subjects = subjectsFor(definition, 'note');
    const counted = subjects.find((subject) => subject.kind === 'entry_count')!;
    expect(subjectKey(counted)).toBe('#count:radiators');

    const clause = { ...clauseFor(counted), operator: 'is_at_least' as const, value: '2' };
    const model: ConditionModel = { match: 'all', clauses: [clause] };
    const expression = completeExpression(model, lookup, subjects);
    expect(expression).toEqual({
      kind: 'compare',
      operator: 'ge',
      left: { kind: 'count', section: 'radiators' },
      right: { kind: 'number', value: '2' },
    });
    expect(fromExpression(expression, lookup)).toEqual(model);
    expect(compiles(withVisibility(definition, 'note', expression!))).toEqual([]);

    expect(subjectProblem({ ...clause, value: '2.5' }, lookup, subjects)).toBe('value_invalid');
    const { value: _value, ...unfinished } = clause;
    expect(subjectProblem(unfinished, lookup, subjects)).toBe('value_required');
    expect(subjectProblem({ ...clause, operator: 'is_answered' }, lookup, subjects)).toBe(
      'operator_not_allowed',
    );
  });
});

describe('calculations across entries', () => {
  it('works out a total, the smallest, the largest and a count, and reads them back', () => {
    const calculation = {
      first: {
        kind: 'aggregate' as const,
        operator: 'sum' as const,
        section: 'radiators',
        field: 'watts',
      },
      rest: [
        { operator: 'divide' as const, term: { kind: 'count' as const, section: 'radiators' } },
      ],
    };
    const expression = fromCalculation(calculation);
    expect(expression).toEqual({
      kind: 'arithmetic',
      operator: 'divide',
      left: { kind: 'aggregate', operator: 'sum', section: 'radiators', field: 'watts' },
      right: { kind: 'count', section: 'radiators' },
    });
    expect(toCalculation(expression)).toEqual(calculation);
    expect(compiles(form({}, [note, { ...total, calculation: expression }]))).toEqual([]);

    for (const term of [calculation.first, calculation.rest[0]!.term]) {
      expect(termFromKey(termKey(term))).toEqual(term);
    }
    expect(termFromKey(termKey({ kind: 'field', field: 'watts' }))).toEqual({
      kind: 'field',
      field: 'watts',
    });
  });

  it('offers each field only what it can read where it sits', () => {
    const outside = calculationSources(form(), 'total');
    expect(outside.fields.map((field) => field.id)).toEqual([]);
    expect(
      outside.sections.map(({ section, numbers }) => [section.id, numbers.map((n) => n.id)]),
    ).toEqual([['radiators', ['watts']]]);

    const inside = calculationSources(
      form({ fields: [room, watts, newField('number', 'doubled', { en: 'Doubled' })] }),
      'doubled',
    );
    expect(inside.fields.map((field) => field.id)).toEqual(['watts', 'total']);
    expect(inside.sections).toEqual([]);
  });
});

describe('what publishing finds', () => {
  const issues = (definition: FormDefinition) => {
    const compiled = compileDefinition(definition);
    return compiled.ok ? [] : compiled.issues;
  };
  const name = (id: string) =>
    ({ radiators: 'Radiators', result: 'Result', watts: 'Output', note: 'Note', site: 'Site' })[
      id
    ] ?? id;

  it('words the problems repeatable sections bring in the admin’s own names', () => {
    const found = [
      ...issues(form({ fields: [] })),
      ...issues(form({ repeat: { maxEntries: 2, minEntries: 3, entryLabel: { en: 'Radiator' } } })),
      ...issues(form({ repeat: { ...radiators.repeat!, titleField: 'evidence' } })),
      ...issues(
        withVisibility(form(), 'note', {
          kind: 'compare',
          operator: 'eq',
          left: { kind: 'answer', field: 'result' },
          right: { kind: 'text', value: 'fail' },
        }),
      ),
      ...issues(
        withVisibility(form(), 'note', {
          kind: 'compare',
          operator: 'gt',
          left: { kind: 'count', section: 'visit' },
          right: { kind: 'number', value: '1' },
        }),
      ),
      ...issues(
        form({}, [
          note,
          {
            ...total,
            calculation: {
              kind: 'aggregate',
              operator: 'sum',
              section: 'radiators',
              field: 'site',
            },
          },
        ]),
      ),
    ];
    expect(found.map((issue) => [issue.code, issueText(issue, name, t)])).toEqual([
      [
        'invalid_repeat',
        '“Radiators” repeats but has no questions to repeat. Add a question to it.',
      ],
      [
        'invalid_repeat',
        '“Radiators” needs more entries than it allows. Make the fewest entries no more than the most.',
      ],
      [
        'invalid_repeat',
        'Each entry of “Radiators” must be named by one of its own short answer, number, date or time questions.',
      ],
      [
        'inside_repeat',
        'A rule reads “Result”, which is asked once for each entry of “Radiators”. Choose whether any entry or every entry must match.',
      ],
      ['not_repeatable', 'A rule reads across the entries of “visit”, but that does not repeat.'],
      [
        'not_in_section',
        'A calculation works across the entries of “Radiators” using “Site”, which is not one of its questions.',
      ],
    ]);
    // Anything else keeps the engine's own message.
    expect(
      issueText({ code: 'duplicate_id', path: '', message: 'Used twice', elements: [] }, name, t),
    ).toBe('Used twice');
  });

  it('explains a question moving into a repeating section, and tighter entry limits', () => {
    const live = form();
    const moved = diffDefinitions(live, {
      ...live,
      pages: [
        {
          id: 'page_1',
          sections: [
            { id: 'visit', fields: [] },
            { ...radiators, fields: [...radiators.fields, site] },
            { id: 'summary', fields: [note, total] },
          ],
        },
      ],
    });
    const tightened = diffDefinitions(
      live,
      form({ repeat: { minEntries: 1, maxEntries: 5, entryLabel: { en: 'Radiator' } } }),
    );
    expect(
      [...moved.breaking, ...tightened.breaking].map((entry) => breakingText(entry, t)),
    ).toEqual([
      'Moved into or out of a repeating section, or its section started or stopped repeating. Answers before and after are kept differently, so reports cannot put them in one column.',
      'Stricter limits on entries: fewest entries, most entries. Some unfinished drafts may need correcting.',
    ]);
  });
});
