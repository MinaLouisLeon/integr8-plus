import { describe, expect, it } from 'vitest';
import { duplicate, findField, isEditError, referencesTo } from './authoring/editing.js';
import { availableOptions, dependentChoiceParent, revealing } from './choices.js';
import { createFormState, transition, viewForm } from './state.js';
import {
  compiled,
  definition,
  field,
  fields,
  issuesOf,
  options,
  page,
  section,
} from './test-support/builders.js';
import { validateForm, validateSubmission } from './validation.js';

/**
 * Dependent choices: "Area" narrows "Room". What is offered, what is refused,
 * and what a definition may say about it.
 */

const area = field('radio', 'area', { options: options('kitchen', 'bathroom', 'outside') });
const room = field('dropdown', 'room', {
  options: options('sink', 'hob', 'bath', 'garden'),
  dependsOn: {
    field: 'area',
    options: { sink: ['kitchen'], hob: ['kitchen'], bath: ['bathroom'] },
  },
});
const hazards = field('multi_select', 'hazards', { options: options('wet', 'gas', 'height') });
const ppe = field('multi_select', 'ppe', {
  options: options('gloves', 'mask', 'harness'),
  dependsOn: {
    field: 'hazards',
    options: { gloves: ['wet', 'gas'], mask: ['gas'], harness: ['height'] },
  },
});

const form = compiled(fields(area, room, hazards, ppe));

describe('what a dependent field offers', () => {
  it('offers nothing while the parent is unanswered, and says so', () => {
    expect(availableOptions(room, undefined)).toEqual({ options: [], parentAnswered: false });
  });

  it('offers what the parent’s answer reveals, plus anything not in the map, in its own order', () => {
    expect(availableOptions(room, { type: 'text', value: 'kitchen' })).toEqual({
      options: ['sink', 'hob', 'garden'],
      parentAnswered: true,
    });
    expect(availableOptions(room, { type: 'text', value: 'outside' })?.options).toEqual(['garden']);
  });

  it('takes the union of what a multi-select parent’s choices reveal', () => {
    expect(availableOptions(ppe, { type: 'options', value: ['gas', 'height'] })?.options).toEqual([
      'gloves',
      'mask',
      'harness',
    ]);
    expect(availableOptions(ppe, { type: 'options', value: ['wet'] })?.options).toEqual(['gloves']);
    expect(availableOptions(ppe, { type: 'options', value: [] })?.options).toEqual([]);
  });

  it('knows nothing about a field that depends on nothing', () => {
    expect(availableOptions(area, { type: 'text', value: 'kitchen' })).toBeUndefined();
    expect(dependentChoiceParent(area)).toBeUndefined();
    expect(dependentChoiceParent(room)).toBe('area');
  });

  it('does not mistake an Object property for an option in the map', () => {
    const map = { field: 'area', options: { sink: ['kitchen'] } };
    expect(revealing(map, 'constructor')).toBeUndefined();
    expect(revealing(map, 'sink')).toEqual(['kitchen']);
  });
});

describe('validating a dependent field', () => {
  it('accepts an answer the parent reveals, and names one it does not', () => {
    expect(validateForm(form, { area: 'kitchen', room: 'hob' }).errors).toEqual([]);
    expect(validateForm(form, { area: 'bathroom', room: 'hob' }).errors).toEqual([
      { field: 'room', code: 'option_unavailable', params: {} },
    ]);
    expect(validateForm(form, { area: 'outside', room: 'garden' }).errors).toEqual([]);
  });

  it('refuses any stored choice while the parent is blank — nothing is offered', () => {
    expect(validateForm(form, { room: 'garden' }).errors).toEqual([
      { field: 'room', code: 'option_unavailable', params: {} },
    ]);
  });

  it('checks every chosen option of a multi-select against the union revealed', () => {
    expect(validateForm(form, { hazards: ['gas'], ppe: ['gloves', 'mask'] }).errors).toEqual([]);
    expect(validateForm(form, { hazards: ['gas'], ppe: ['mask', 'harness'] }).errors).toEqual([
      { field: 'ppe', code: 'option_unavailable', params: {} },
    ]);
  });

  it('does not pile "unavailable" on an answer that is not an option at all', () => {
    expect(
      validateForm(form, { area: 'kitchen', room: 'attic' }).errors.map((error) => error.code),
    ).toEqual(['unknown_option']);
  });

  it('tells the view what each dependent field offers as the answers change', () => {
    let state = createFormState(form);
    let view = viewForm(form, state);
    expect([...view.availableOptions]).toEqual([
      ['room', { options: [], parentAnswered: false }],
      ['ppe', { options: [], parentAnswered: false }],
    ]);
    state = transition(form, state, { type: 'answer', field: 'area', value: 'kitchen' }).state;
    state = transition(form, state, { type: 'answer', field: 'room', value: 'sink' }).state;
    view = viewForm(form, state);
    expect(view.availableOptions.get('room')).toEqual({
      options: ['sink', 'hob', 'garden'],
      parentAnswered: true,
    });
    expect(view.errors).toEqual([]);

    // Changing the parent keeps the answer and says what is wrong with it.
    state = transition(form, state, { type: 'answer', field: 'area', value: 'bathroom' }).state;
    view = viewForm(form, state);
    expect(view.values.get('room')).toBe('sink');
    expect(view.errors).toEqual([{ field: 'room', code: 'option_unavailable', params: {} }]);
  });

  it('is judged the same way on the server', () => {
    const check = validateSubmission(form, { area: 'kitchen', room: 'bath' });
    expect(check.valid).toBe(false);
    expect(check.errors).toEqual([{ field: 'room', code: 'option_unavailable', params: {} }]);
  });

  it('reads the parent inside the same entry of a repeatable section', () => {
    const repeating = compiled(
      definition([
        page('p', [
          section('rooms', [area, room], {
            repeat: { maxEntries: 5, entryLabel: { en: 'Room' } },
          }),
        ]),
      ]),
    );
    const validation = validateForm(repeating, {
      rooms: [
        { id: 'e1', values: { area: 'kitchen', room: 'sink' } },
        { id: 'e2', values: { area: 'bathroom', room: 'sink' } },
      ],
    });
    expect(validation.errors).toEqual([
      { field: 'room', code: 'option_unavailable', params: {}, entry: 'e2' },
    ]);
    expect(validation.availableOptions.get('e1/room')?.options).toEqual(['sink', 'hob', 'garden']);
    expect(validation.availableOptions.get('e2/room')?.options).toEqual(['bath', 'garden']);
  });
});

describe('compiling dependent choices', () => {
  const dependent = (dependsOn: { field: string; options: Record<string, string[]> }) =>
    field('dropdown', 'room', { options: options('a', 'b'), dependsOn });

  it('refuses a parent that is missing, a section, or not a choice', () => {
    expect(
      issuesOf(fields(area, dependent({ field: 'nowhere', options: {} }))).map(
        (issue) => `${issue.code}: ${issue.message}`,
      ),
    ).toEqual([
      'unknown_field: The choices of "room" depend on "nowhere", which is not in this form',
    ]);
    expect(issuesOf(fields(area, dependent({ field: 'section_1', options: {} })))).toMatchObject([
      { code: 'not_a_field', path: 'pages[0].sections[0].fields[1].dependsOn' },
    ]);
    expect(
      issuesOf(fields(field('number', 'count'), dependent({ field: 'count', options: {} }))).map(
        (issue) => issue.message,
      ),
    ).toEqual([
      'The choices of "room" depend on "count", which is a number question, not a choice',
    ]);
  });

  it('refuses a parent value, or an own option, that does not exist', () => {
    expect(
      issuesOf(fields(area, dependent({ field: 'area', options: { a: ['loft'] } }))),
    ).toMatchObject([
      {
        code: 'unknown_option',
        message: '"area" has no option "loft"',
        path: 'pages[0].sections[0].fields[1].dependsOn.options.a',
        elements: ['area'],
      },
    ]);
    expect(
      issuesOf(fields(area, dependent({ field: 'area', options: { c: ['kitchen'] } }))),
    ).toMatchObject([
      {
        code: 'invalid_field_config',
        path: 'pages[0].sections[0].fields[1].dependsOn.options.c',
      },
    ]);
  });

  it('allows a yes/no parent, and refuses an option it does not offer', () => {
    const safe = field('yes_no', 'safe');
    expect(() =>
      compiled(fields(safe, dependent({ field: 'safe', options: { a: ['yes'] } }))),
    ).not.toThrow();
    expect(
      issuesOf(fields(safe, dependent({ field: 'safe', options: { a: ['not_applicable'] } }))),
    ).toMatchObject([{ code: 'unknown_option' }]);
  });

  it('refuses a parent asked once per entry from outside its entries', () => {
    const issues = issuesOf(
      definition([
        page('p', [
          section('rooms', [area], { repeat: { maxEntries: 3, entryLabel: { en: 'Room' } } }),
          section('summary', [dependent({ field: 'area', options: {} })]),
        ]),
      ]),
    );
    expect(issues).toMatchObject([{ code: 'inside_repeat', elements: ['area', 'rooms'] }]);
  });

  it('refuses a field whose choices depend on itself, or on each other', () => {
    expect(
      issuesOf(fields(dependent({ field: 'room', options: {} }))).map((issue) => issue.message),
    ).toEqual([
      'Circular rule: field "room" offers choices depending on itself. None of these can be worked out until another one is.',
    ]);
    expect(
      issuesOf(
        fields(
          field('radio', 'a', { options: options('x'), dependsOn: { field: 'b', options: {} } }),
          field('radio', 'b', { options: options('x'), dependsOn: { field: 'a', options: {} } }),
        ),
      ).map((issue) => issue.elements),
    ).toEqual([['a', 'b']]);
  });
});

describe('editing dependent choices', () => {
  it('names the dependency as a reference before the parent is deleted', () => {
    expect(referencesTo(fields(area, room), ['area'])).toEqual([
      { from: 'room', where: 'dependsOn', to: 'area' },
    ]);
    expect(referencesTo(fields(area, room), ['area', 'room'])).toEqual([]);
  });

  it('points a duplicated section’s dependency at the copy', () => {
    const copy = duplicate(fields(area, room), 'section_1');
    if (isEditError(copy)) throw new Error(copy.error);
    const copied = findField(copy.definition, 'room_copy');
    expect(copied?.type === 'dropdown' ? copied.dependsOn : undefined).toEqual({
      ...room.dependsOn,
      field: 'area_copy',
    });
  });
});
