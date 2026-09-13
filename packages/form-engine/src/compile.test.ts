import { describe, expect, it } from 'vitest';
import { compileDefinition } from './compile.js';
import { LIMITS } from './definition.js';
import type { Expression } from './expression.js';
import {
  all,
  answer,
  answered,
  bool,
  compiled,
  date,
  datetime,
  definition,
  eq,
  field,
  fields,
  gt,
  includes,
  issuesOf,
  label,
  lt,
  not,
  num,
  options,
  page,
  plus,
  section,
  text,
  time,
  today,
} from './test-support/builders.js';

describe('a valid definition', () => {
  it('compiles, keeping every field in reading order', () => {
    const form = compiled(
      definition([
        page('site', [section('arrival', [field('time', 'arrived'), field('text', 'contact')])]),
        page('work', [section('checks', [field('yes_no', 'isolated')])]),
      ]),
    );

    expect(form.fields.map((member) => member.id)).toEqual(['arrived', 'contact', 'isolated']);
    expect(form.elements.get('contact')).toMatchObject({
      kind: 'field',
      parent: 'arrival',
      path: 'pages[0].sections[0].fields[1]',
    });
    expect(form.elements.get('checks')).toMatchObject({
      kind: 'section',
      parent: 'work',
      path: 'pages[1].sections[0]',
    });
  });

  it('orders evaluation so every dependency comes before what depends on it', () => {
    const form = compiled(
      fields(
        field('number', 'total', { calculation: plus(answer('parts'), answer('labour')) }),
        field('number', 'parts'),
        field('number', 'labour', { visibleWhen: answered('parts') }),
      ),
    );
    const at = (id: string) => form.evaluationOrder.indexOf(id);

    expect(at('parts')).toBeLessThan(at('labour'));
    expect(at('labour')).toBeLessThan(at('total'));
    expect(at('section_1')).toBeLessThan(at('parts'));
    expect(at('page_1')).toBeLessThan(at('section_1'));
    expect(new Set(form.evaluationOrder).size).toBe(form.elements.size);
  });

  it('returns a frozen form', () => {
    expect(Object.isFrozen(compiled(fields(field('text', 't'))))).toBe(true);
  });
});

describe('structure', () => {
  it('refuses a definition that does not match the schema, with a path', () => {
    const issues = issuesOf({
      schemaVersion: 1,
      title: label('x'),
      pages: [
        {
          id: 'p',
          sections: [{ id: 's', fields: [{ id: 'f', type: 'hologram', label: label('f') }] }],
        },
      ],
    });
    expect(issues[0]).toMatchObject({
      code: 'invalid_structure',
      path: 'pages[0].sections[0].fields[0].type',
    });
  });

  it('refuses a definition from a schema version it does not know', () => {
    expect(issuesOf({ ...fields(field('text', 't')), schemaVersion: 2 })[0]).toMatchObject({
      code: 'invalid_structure',
      path: 'schemaVersion',
    });
  });

  it('refuses a property it does not recognise, rather than ignoring it', () => {
    const issues = issuesOf(fields({ ...field('text', 't'), placeholder: 'Type here' } as never));
    expect(issues[0]?.code).toBe('invalid_structure');
    expect(issues[0]?.message).toMatch(/placeholder/u);
  });

  it('refuses ids that could not be a JSON key, a column name and a CSV header all at once', () => {
    for (const id of ['Result', '1st', 'site-access', 'ok'.padEnd(65, 'k'), '']) {
      expect(issuesOf(fields(field('text', id)))[0]?.code).toBe('invalid_structure');
    }
  });

  it('refuses a label in no language', () => {
    expect(issuesOf(fields({ ...field('text', 't'), label: {} }))[0]?.message).toMatch(
      /at least one language/u,
    );
  });

  it('refuses the same id twice, across pages, sections and fields alike', () => {
    const issues = issuesOf(
      definition([
        page('site', [
          section('site', [field('text', 'contact')]),
          section('other', [field('text', 'contact')]),
        ]),
      ]),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_id', 'duplicate_id']);
    expect(issues[1]?.message).toBe(
      'The id "contact" is used twice, at pages[0].sections[0].fields[0] and pages[0].sections[1].fields[0]. Pages, sections and fields share one set of ids.',
    );
  });

  it('refuses more fields than the limit', () => {
    const many = Array.from({ length: LIMITS.fieldsPerSection }, (_, index) =>
      field('checkbox', `f${String(index)}`),
    );
    const sections = Array.from(
      { length: Math.ceil(LIMITS.fieldsTotal / LIMITS.fieldsPerSection) + 1 },
      (_, index) =>
        section(
          `s${String(index)}`,
          many.map((member) => ({ ...member, id: `${member.id}_${String(index)}` })),
        ),
    );
    expect(issuesOf(definition([page('p', sections)]))[0]).toMatchObject({ code: 'too_large' });
  });
});

describe('field configuration', () => {
  it('is reported with the field named and the property pointed at', () => {
    const issues = issuesOf(
      fields(field('text', 'first'), field('number', 'count', { min: 5, max: 1 })),
    );
    expect(issues).toEqual([
      {
        code: 'invalid_field_config',
        message: 'Field "count": min 5 is above max 1',
        path: 'pages[0].sections[0].fields[1].min',
        elements: ['count'],
      },
    ]);
  });
});

describe('references', () => {
  it('refuses a rule on a field that does not exist', () => {
    const issues = issuesOf(
      fields(field('text', 'reason', { visibleWhen: eq(answer('reslt'), text('fail')) })),
    );
    expect(issues).toEqual([
      {
        code: 'unknown_field',
        message: 'A rule refers to "reslt", which is not in this form',
        path: 'pages[0].sections[0].fields[0].visibleWhen',
        elements: ['reslt'],
      },
    ]);
  });

  it('refuses a rule that reads a section as though it were a field', () => {
    const issues = issuesOf(
      fields(field('text', 'reason', { visibleWhen: answered('section_1') })),
    );
    expect(issues[0]).toMatchObject({
      code: 'not_a_field',
      message: 'A rule refers to "section_1", which is a section, not a field',
    });
  });

  it('checks references in custom rules and calculations too', () => {
    const rule = {
      id: 'after_start',
      assert: gt(answer('finished'), answer('begun')),
      message: label('Must finish after starting'),
    };
    expect(issuesOf(fields(field('time', 'finished', { rules: [rule] })))[0]?.elements).toEqual([
      'begun',
    ]);
    expect(
      issuesOf(
        fields(field('number', 'total', { calculation: plus(answer('nothing'), num('1')) })),
      )[0],
    ).toMatchObject({
      code: 'unknown_field',
      path: 'pages[0].sections[0].fields[0].calculation',
    });
  });

  it('catches a misspelled option at publish time, on either side of the comparison', () => {
    const result = field('radio', 'result', { options: options('pass', 'fail') });
    expect(
      issuesOf(
        fields(
          result,
          field('text', 'reason', { visibleWhen: eq(answer('result'), text('fial')) }),
        ),
      )[0],
    ).toMatchObject({
      code: 'unknown_option',
      message: '"result" has no option "fial"',
      elements: ['result'],
    });
    expect(
      issuesOf(
        fields(
          result,
          field('text', 'reason', { visibleWhen: eq(text('fial'), answer('result')) }),
        ),
      )[0]?.code,
    ).toBe('unknown_option');
    expect(
      issuesOf(
        fields(
          field('yes_no', 'ok'),
          field('text', 'why', { visibleWhen: eq(answer('ok'), text('maybe')) }),
        ),
      )[0]?.code,
    ).toBe('unknown_option');
  });

  it('refuses includes on anything but a multi-select, and an option it lacks', () => {
    expect(
      issuesOf(
        fields(field('radio', 'r'), field('text', 't', { visibleWhen: includes('r', 'a') })),
      )[0],
    ).toMatchObject({ code: 'type_mismatch' });
    expect(
      issuesOf(
        fields(field('multi_select', 'm'), field('text', 't', { visibleWhen: includes('m', 'z') })),
      )[0],
    ).toMatchObject({ code: 'unknown_option' });
  });
});

describe('types', () => {
  const typeIssue = (condition: Expression, ...others: ReturnType<typeof field>[]) =>
    issuesOf(fields(...others, field('text', 'target', { visibleWhen: condition })))[0];

  it('requires a condition to be true or false', () => {
    expect(typeIssue(answer('count'), field('number', 'count'))).toMatchObject({
      code: 'type_mismatch',
      message: 'The condition on "target" must be true or false, but it produces a number value',
    });
  });

  it('requires a calculation to produce a number', () => {
    expect(
      issuesOf(
        fields(field('checkbox', 'c'), field('number', 'n', { calculation: answer('c') })),
      )[0]?.message,
    ).toBe('The calculation for "n" must produce a number, but it produces a boolean value');
  });

  it('refuses comparing different kinds of value', () => {
    expect(typeIssue(eq(answer('count'), text('3')), field('number', 'count'))?.message).toBe(
      'A number value cannot be compared with a text value',
    );
  });

  it('refuses ordering values that have no order', () => {
    expect(typeIssue(lt(answer('name'), text('m')), field('text', 'name'))?.message).toBe(
      'A text value has no order, so "lt" does not apply',
    );
  });

  it('allows a photo, a file, a signature or a location to be tested only for whether it was given', () => {
    expect(
      typeIssue(eq(answer('p'), answer('q')), field('photo', 'p'), field('photo', 'q'))?.message,
    ).toMatch(/only be tested for whether it was given/u);
    expect(
      typeIssue(
        eq(answer('m'), answer('n')),
        field('multi_select', 'm'),
        field('multi_select', 'n'),
      )?.message,
    ).toMatch(/tested with "includes"/u);
    expect(
      compileDefinition(
        fields(field('photo', 'p'), field('text', 't', { visibleWhen: answered('p') })),
      ).ok,
    ).toBe(true);
  });

  it('refuses arithmetic on anything but numbers', () => {
    expect(
      issuesOf(
        fields(
          field('text', 't'),
          field('number', 'n', { calculation: plus(answer('t'), num('1')) }),
        ),
      )[0]?.message,
    ).toBe('"add" needs two numbers, not text and number');
  });

  it('refuses logic on anything but true-or-false', () => {
    expect(typeIssue(not(answer('count')), field('number', 'count'))?.message).toMatch(
      /"not" needs a true-or-false value/u,
    );
    expect(
      typeIssue(all(answered('count'), answer('count')), field('number', 'count'))?.message,
    ).toMatch(/Every part of "all"/u);
  });

  it.each([
    [num('1.2.3'), /not a number a rule can use/u],
    [date('13/09/2026'), /not a date in the form YYYY-MM-DD/u],
    [time('9am'), /not a time in the form HH:MM/u],
    [datetime('2026-09-13T10:00'), /not a date and time with an offset/u],
  ])('refuses a literal that does not parse: %j', (literal, message) => {
    expect(typeIssue(eq(literal, literal))?.message).toMatch(message);
  });

  it('accepts dates compared with today, times with times, datetimes with datetimes', () => {
    expect(
      compileDefinition(
        fields(
          field('date', 'due'),
          field('time', 'at'),
          field('datetime', 'logged'),
          field('text', 'late', {
            visibleWhen: all(
              lt(answer('due'), today()),
              gt(answer('at'), time('17:00')),
              lt(answer('logged'), datetime('2026-01-01T00:00Z')),
              bool(true),
            ),
          }),
        ),
      ).ok,
    ).toBe(true);
  });

  it('refuses an expression too large to evaluate cheaply', () => {
    let deep: Expression = bool(true);
    for (let level = 0; level < LIMITS.expressionDepth; level += 1) {
      deep = not(deep);
    }
    expect(issuesOf(fields(field('text', 't', { visibleWhen: deep })))[0]).toMatchObject({
      code: 'expression_too_complex',
      elements: ['t'],
    });

    const wide = all(
      ...Array.from({ length: 100 }, () => all(...Array.from({ length: 5 }, () => bool(true)))),
    );
    expect(issuesOf(fields(field('text', 't', { visibleWhen: wide })))[0]?.code).toBe(
      'expression_too_complex',
    );
  });
});

describe('circular rules — refused at publish, with every field named', () => {
  it('names a field whose visibility depends on its own answer', () => {
    const issues = issuesOf(fields(field('text', 'notes', { visibleWhen: answered('notes') })));

    expect(issues).toEqual([
      {
        code: 'circular_dependency',
        message:
          'Circular rule: field "notes" is shown depending on itself. None of these can be worked out until another one is.',
        path: 'pages[0].sections[0].fields[0]',
        elements: ['notes'],
      },
    ]);
  });

  it('names both fields of a two-field loop, in reading order, with the reason for each link', () => {
    const issues = issuesOf(
      fields(
        field('text', 'first', { visibleWhen: answered('second') }),
        field('text', 'second', { visibleWhen: answered('first') }),
      ),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.elements).toEqual(['first', 'second']);
    expect(issues[0]?.message).toBe(
      'Circular rule: field "first" is shown depending on field "second", and field "second" is shown depending on field "first". None of these can be worked out until another one is.',
    );
  });

  it('follows a loop through a calculation', () => {
    const issues = issuesOf(
      fields(
        field('number', 'subtotal', { calculation: plus(answer('total'), num('1')) }),
        field('number', 'total', { calculation: plus(answer('subtotal'), num('1')) }),
      ),
    );
    expect(issues[0]?.message).toBe(
      'Circular rule: field "subtotal" is calculated from field "total", and field "total" is calculated from field "subtotal". None of these can be worked out until another one is.',
    );
  });

  it('follows a loop that mixes a calculation and a condition across three fields', () => {
    const issues = issuesOf(
      fields(
        field('number', 'hours', { visibleWhen: gt(answer('cost'), num('0')) }),
        field('decimal', 'rate', { decimalPlaces: 2, visibleWhen: answered('hours') }),
        field('decimal', 'cost', { decimalPlaces: 2, calculation: plus(answer('rate'), num('0')) }),
      ),
    );
    expect(issues[0]?.elements).toEqual(['hours', 'cost', 'rate']);
    expect(issues[0]?.message).toMatch(
      /field "hours" is shown depending on field "cost", and field "cost" is calculated from field "rate", and field "rate" is shown depending on field "hours"/u,
    );
  });

  it('refuses a section shown only when a field inside it is answered — it could never appear', () => {
    const issues = issuesOf(
      definition([
        page('page_1', [
          section('failure', [field('text', 'reason')], { visibleWhen: answered('reason') }),
        ]),
      ]),
    );
    expect(issues[0]?.message).toBe(
      'Circular rule: section "failure" is shown depending on field "reason", and field "reason" is inside section "failure". None of these can be worked out until another one is.',
    );
    expect(issues[0]?.path).toBe('pages[0].sections[0]');
  });

  it('refuses the same shape one level up, on a page', () => {
    const issues = issuesOf(
      definition([
        page('extra', [section('s', [field('checkbox', 'wanted')])], {
          visibleWhen: answered('wanted'),
        }),
      ]),
    );
    expect(issues[0]?.elements).toEqual(['extra', 'wanted', 's']);
  });

  it('reports each distinct loop once, however many elements lead into it', () => {
    const issues = issuesOf(
      fields(
        field('text', 'a', { visibleWhen: answered('b') }),
        field('text', 'b', { visibleWhen: answered('a') }),
        field('text', 'c', { visibleWhen: answered('a') }),
        field('text', 'd', { visibleWhen: answered('b') }),
        field('text', 'x', { visibleWhen: answered('y') }),
        field('text', 'y', { visibleWhen: answered('x') }),
      ),
    );
    expect(issues.map((issue) => issue.elements)).toEqual([
      ['a', 'b'],
      ['x', 'y'],
    ]);
  });

  it('does not mistake a shared dependency for a loop', () => {
    expect(
      compileDefinition(
        fields(
          field('radio', 'result', { options: options('pass', 'fail') }),
          field('text', 'reason', { visibleWhen: eq(answer('result'), text('fail')) }),
          field('text', 'action', {
            visibleWhen: all(eq(answer('result'), text('fail')), answered('reason')),
          }),
        ),
      ).ok,
    ).toBe(true);
  });

  it('allows a custom rule to read a field that reads it back — rules change no values', () => {
    const rule = (id: string, other: string) => ({
      id: `check_${id}`,
      assert: answered(other),
      message: label('x'),
    });
    expect(
      compileDefinition(
        fields(
          field('text', 'a', { rules: [rule('a', 'b')] }),
          field('text', 'b', { rules: [rule('b', 'a')] }),
        ),
      ).ok,
    ).toBe(true);
  });

  it('survives a long chain without exhausting the stack', () => {
    const chain = Array.from({ length: 200 }, (_, index) =>
      field(
        'checkbox',
        `step_${String(index)}`,
        index === 0 ? {} : { visibleWhen: answered(`step_${String(index - 1)}`) },
      ),
    );
    const result = compileDefinition(fields(...chain));
    expect(result.ok).toBe(true);
  });
});
