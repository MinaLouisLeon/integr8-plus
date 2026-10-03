import { describe, expect, it } from 'vitest';
import type { FormDefinition } from '../definition.js';
import type { Field, FieldOf } from '../field-types.js';
import { answer, field, fields, options, page, section } from '../test-support/builders.js';
import { type BreakingChange, diffDefinitions } from './diff.js';
import { addField, isEditError, moveField, remove, updateField } from './editing.js';

const live = (): FormDefinition =>
  fields(
    field('radio', 'result', { options: options('pass', 'fail', 'deferred') }),
    field('text', 'reason', { maxLength: 200 }),
    field('number', 'readings', { min: 0, max: 100 }),
    field('decimal', 'pressure', { decimalPlaces: 2, min: '0.00', max: '50.00' }),
    field('date', 'installed', { earliest: '2000-01-01' }),
    field('photo', 'evidence', { maxFiles: 5 }),
  );

const apply = (
  definition: FormDefinition,
  edit: (form: FormDefinition) => ReturnType<typeof updateField>,
) => {
  const result = edit(definition);
  if (isEditError(result)) throw new Error(JSON.stringify(result));
  return result;
};

const change = (id: string, update: (field: Field) => Field) => (form: FormDefinition) =>
  updateField(form, id, update);

const breaking = (draft: FormDefinition): BreakingChange[] =>
  diffDefinitions(live(), draft).breaking;

describe('what changed', () => {
  it('reports nothing for an identical draft', () => {
    expect(diffDefinitions(live(), live())).toEqual({
      titleChanged: false,
      changes: [],
      breaking: [],
    });
  });

  it('treats a first version as all additions, with nothing breaking', () => {
    const diff = diffDefinitions(undefined, live());
    expect(diff.changes.every((entry) => entry.kind === 'added')).toBe(true);
    expect(diff.changes).toHaveLength(8);
    expect(diff.breaking).toEqual([]);
    expect(diff.titleChanged).toBe(false);
  });

  it('names changed properties, sorted, and ignores property order', () => {
    const draft = apply(
      live(),
      change('reason', (target) => ({
        ...target,
        required: true,
        label: { en: 'Why?' },
        help: { en: 'Be specific' },
      })),
    );
    const reordered = apply(
      live(),
      change('reason', (target) => Object.fromEntries(Object.entries(target).reverse()) as Field),
    );

    expect(diffDefinitions(live(), draft).changes).toEqual([
      {
        kind: 'changed',
        elementKind: 'field',
        element: 'reason',
        properties: ['help', 'label', 'required'],
      },
    ]);
    expect(diffDefinitions(live(), reordered).changes).toEqual([]);
  });

  it('reports additions in the draft’s order and removals after them', () => {
    let draft = apply(live(), (form) =>
      addField(form, 'section_1', field('checkbox', 'confirmed'), 0),
    );
    draft = apply(draft, (form) => remove(form, 'evidence'));
    expect(
      diffDefinitions(live(), draft).changes.map((entry) => `${entry.kind}:${entry.element}`),
    ).toEqual([
      'added:confirmed',
      'moved:result',
      'moved:reason',
      'moved:readings',
      'moved:pressure',
      'moved:installed',
      'removed:evidence',
    ]);
  });

  it('reports a move between sections, and a changed title', () => {
    const base: FormDefinition = {
      schemaVersion: 1,
      title: { en: 'A' },
      pages: [page('p', [section('one', [field('text', 'x')]), section('two', [])])],
    };
    const draft = { ...apply(base, (form) => moveField(form, 'x', 'two', 0)), title: { en: 'B' } };
    const diff = diffDefinitions(base, draft);
    expect(diff.titleChanged).toBe(true);
    expect(diff.changes).toEqual([
      { kind: 'moved', elementKind: 'field', element: 'x', properties: [] },
    ]);
  });

  it('reports changes to sections and pages as their own properties, not their children', () => {
    const draft = apply(live(), (form) => ({
      ...form,
      pages: [{ ...form.pages[0]!, title: { en: 'Checks' } }],
    }));
    expect(diffDefinitions(live(), draft).changes).toEqual([
      { kind: 'changed', elementKind: 'page', element: 'page_1', properties: ['title'] },
    ]);
  });
});

describe('what breaks', () => {
  it('flags a removed field as costing reporting continuity', () => {
    expect(breaking(apply(live(), (form) => remove(form, 'reason')))).toEqual([
      { field: 'reason', reason: 'field_removed', affects: 'reporting', detail: [] },
    ]);
  });

  it('flags a changed type, and nothing else about that field', () => {
    const draft = apply(
      live(),
      change('readings', (target) => ({
        id: target.id,
        label: target.label,
        type: 'text',
        required: true,
      })),
    );
    expect(breaking(draft)).toEqual([
      {
        field: 'readings',
        reason: 'type_changed',
        affects: 'reporting',
        detail: ['number', 'text'],
      },
    ]);
  });

  it('flags removed options by value', () => {
    const draft = apply(
      live(),
      change('result', (target) => ({ ...target, options: options('pass', 'fail') }) as Field),
    );
    expect(breaking(draft)).toEqual([
      { field: 'result', reason: 'option_removed', affects: 'reporting', detail: ['deferred'] },
    ]);
  });

  it('does not flag an added option', () => {
    const draft = apply(
      live(),
      change(
        'result',
        (target) =>
          ({ ...target, options: options('pass', 'fail', 'deferred', 'no_access') }) as Field,
      ),
    );
    expect(breaking(draft)).toEqual([]);
  });

  it('flags a field becoming calculated', () => {
    const draft = apply(
      live(),
      change('readings', (target) => ({ ...target, calculation: answer('readings') }) as Field),
    );
    expect(breaking(draft).map((entry) => entry.reason)).toEqual(['now_calculated']);
  });

  it('flags a field becoming required as affecting drafts, not reports', () => {
    expect(
      breaking(
        apply(
          live(),
          change('reason', (target) => ({ ...target, required: true })),
        ),
      ),
    ).toEqual([
      { field: 'reason', reason: 'now_required', affects: 'drafts', detail: ['required'] },
    ]);
  });

  it.each([
    ['reason', { maxLength: 100 }, ['maxLength']],
    ['reason', { minLength: 3 }, ['minLength']],
    ['readings', { min: 5, max: 90 }, ['max', 'min']],
    ['pressure', { max: '49.99' }, ['max']],
    ['pressure', { decimalPlaces: 1 }, ['decimalPlaces']],
    ['installed', { earliest: '2010-01-01' }, ['earliest']],
    ['installed', { latest: '2030-01-01' }, ['latest']],
    [
      'evidence',
      { maxFiles: 2, minFiles: 1, maxFileBytes: 1000 },
      ['maxFileBytes', 'maxFiles', 'minFiles'],
    ],
    ['reason', { pattern: { source: '[A-Z]+' } }, ['pattern']],
  ])('flags %s tightened by %j', (id, patch, properties) => {
    const draft = apply(
      live(),
      change(id, (target) => ({ ...target, ...patch }) as Field),
    );
    expect(breaking(draft)).toEqual([
      { field: id, reason: 'constraint_tightened', affects: 'drafts', detail: properties },
    ]);
  });

  it.each([
    ['reason', { maxLength: 500 }],
    ['readings', { min: -5, max: 1000 }],
    ['pressure', { decimalPlaces: 3 }],
    ['installed', { earliest: '1990-01-01' }],
    ['evidence', { maxFiles: 10 }],
  ])('does not flag %s loosened by %j', (id, patch) => {
    expect(
      breaking(
        apply(
          live(),
          change(id, (target) => ({ ...target, ...patch }) as Field),
        ),
      ),
    ).toEqual([]);
  });

  it('does not flag removing a limit, which loosens it', () => {
    expect(
      breaking(
        apply(
          live(),
          change('reason', (target) => {
            const { maxLength: _removed, ...rest } = target as FieldOf<'text'>;
            return rest;
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('flags tighter accuracy on a location and a narrower list of accepted files', () => {
    const base = fields(
      field('gps', 'site', { maxAccuracyMeters: '50' }),
      field('file', 'cert', { acceptedTypes: ['application/pdf', 'image/*'] }),
    );
    const draft = fields(
      field('gps', 'site', { maxAccuracyMeters: '20' }),
      field('file', 'cert', { acceptedTypes: ['application/pdf'] }),
    );
    expect(
      diffDefinitions(base, draft).breaking.map(
        (entry) => `${entry.field}:${entry.detail.join(',')}`,
      ),
    ).toEqual(['site:maxAccuracyMeters', 'cert:acceptedTypes']);
    const looser = fields(
      field('gps', 'site', { maxAccuracyMeters: '80' }),
      field('file', 'cert', { acceptedTypes: ['application/pdf', 'image/*'] }),
    );
    expect(diffDefinitions(base, looser).breaking).toEqual([]);
  });

  it('flags disallowing "not applicable" on a yes/no as a removed option', () => {
    const base = fields(field('yes_no', 'safe', { allowNotApplicable: true }));
    const draft = fields(field('yes_no', 'safe'));
    expect(diffDefinitions(base, draft).breaking).toEqual([
      { field: 'safe', reason: 'option_removed', affects: 'reporting', detail: ['not_applicable'] },
    ]);
  });

  it('flags a limit appearing where there was none', () => {
    const base = fields(field('time', 'arrived'), field('rating', 'score', { scale: 10 }));
    const draft = fields(
      field('time', 'arrived', { earliest: '06:00' }),
      field('rating', 'score', { scale: 5 }),
    );
    expect(diffDefinitions(base, draft).breaking.map((entry) => entry.detail)).toEqual([
      ['earliest'],
      ['scale'],
    ]);
  });

  it('reports several breaking changes on one field separately', () => {
    const draft = apply(
      live(),
      change(
        'result',
        (target) => ({ ...target, required: true, options: options('pass') }) as Field,
      ),
    );
    expect(breaking(draft).map((entry) => entry.reason)).toEqual([
      'option_removed',
      'now_required',
    ]);
  });
});
