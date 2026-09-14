import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileDefinition } from '../compile.js';
import type { FormDefinition } from '../definition.js';
import { FIELD_TYPES, type FieldType } from '../field-types.js';
import {
  answer,
  answered,
  eq,
  field,
  fields,
  page,
  section,
  text,
} from '../test-support/builders.js';
import {
  addField,
  addPage,
  addSection,
  allIds,
  duplicate,
  type EditResult,
  fieldsOf,
  findField,
  isEditError,
  locate,
  moveField,
  movePage,
  moveSection,
  referencesTo,
  remove,
  subtreeIds,
  updateField,
  updatePage,
  updateSection,
} from './editing.js';
import { emptyDefinition, generateId, newField, newPage, newSection } from './scaffold.js';

const ok = (result: EditResult): FormDefinition => {
  if (isEditError(result)) {
    throw new Error(`edit failed: ${JSON.stringify(result)}`);
  }
  return result;
};

const ids = (definition: FormDefinition) => allIds(definition);

const inspection = (): FormDefinition => ({
  schemaVersion: 1,
  title: { en: 'Inspection' },
  pages: [
    page('checks', [
      section('outcome', [
        field('radio', 'result', {
          options: [
            { value: 'pass', label: { en: 'Pass' } },
            { value: 'fail', label: { en: 'Fail' } },
          ],
        }),
        field('text', 'reason', { visibleWhen: eq(answer('result'), text('fail')) }),
      ]),
      section('notes_section', [field('long_text', 'notes')]),
    ]),
    page('sign_off', [
      section('signature_section', [
        field('signature', 'signed', { visibleWhen: answered('result') }),
      ]),
    ]),
  ],
});

describe('generating ids', () => {
  it('derives a readable id from the label', () => {
    expect(generateId('Gas pressure (mbar)', 'field', [])).toBe('gas_pressure_mbar');
  });

  it('keeps ids unique with a numeric suffix', () => {
    expect(generateId('Result', 'field', ['result'])).toBe('result_2');
    expect(generateId('Result', 'field', ['result', 'result_2'])).toBe('result_3');
  });

  it('falls back to the kind for a label with no Latin letters, such as Arabic', () => {
    expect(generateId('ضغط الغاز', 'field', [])).toBe('field');
    expect(generateId('الصفحة', 'page', ['page'])).toBe('page_2');
  });

  it('starts with a letter even when the label starts with a digit', () => {
    expect(generateId('2nd visit', 'field', [])).toBe('f_2nd_visit');
  });

  it('stays within 64 characters, suffix included', () => {
    const long = 'a'.repeat(80);
    const first = generateId(long, 'field', []);
    expect(first).toHaveLength(64);
    expect(generateId(long, 'field', [first])).toHaveLength(64);
  });
});

describe('scaffolding', () => {
  it('produces a field of every type that compiles as it stands', () => {
    for (const { type } of FIELD_TYPES) {
      const result = compileDefinition(fields(newField(type, 'f', { en: 'F' })));
      expect(result.ok, type).toBe(true);
    }
  });

  it('starts a form that compiles once it has one field', () => {
    const empty = emptyDefinition({ en: 'New form' });
    expect(empty.pages[0]?.sections[0]?.fields).toEqual([]);
    expect(
      compileDefinition(ok(addField(empty, 'section_1', newField('text', 'name', { en: 'Name' }))))
        .ok,
    ).toBe(true);
  });
});

describe('adding and locating', () => {
  it('adds fields, sections and pages at a position, or at the end', () => {
    let form = inspection();
    form = ok(addField(form, 'outcome', field('checkbox', 'first'), 0));
    form = ok(addField(form, 'outcome', field('checkbox', 'last')));
    form = ok(addSection(form, 'checks', newSection('extra'), 1));
    form = addPage(form, newPage('cover', [newSection('cover_section')]), 0);

    expect(form.pages.map((candidate) => candidate.id)).toEqual(['cover', 'checks', 'sign_off']);
    expect(form.pages[1]?.sections.map((candidate) => candidate.id)).toEqual([
      'outcome',
      'extra',
      'notes_section',
    ]);
    expect(
      fieldsOf(form)
        .map((candidate) => candidate.id)
        .slice(0, 4),
    ).toEqual(['first', 'result', 'reason', 'last']);
  });

  it('refuses to add into something that is not there, or is the wrong kind', () => {
    expect(addField(inspection(), 'nowhere', field('text', 'x'))).toEqual({
      error: 'not_found',
      id: 'nowhere',
    });
    expect(addField(inspection(), 'checks', field('text', 'x'))).toEqual({
      error: 'not_found',
      id: 'checks',
    });
    expect(addSection(inspection(), 'outcome', newSection('x'))).toEqual({
      error: 'not_found',
      id: 'outcome',
    });
  });

  it('locates any element', () => {
    const form = inspection();
    expect(locate(form, 'sign_off')).toEqual({
      kind: 'page',
      page: 1,
      section: undefined,
      field: undefined,
    });
    expect(locate(form, 'notes_section')).toEqual({
      kind: 'section',
      page: 0,
      section: 1,
      field: undefined,
    });
    expect(locate(form, 'reason')).toEqual({ kind: 'field', page: 0, section: 0, field: 1 });
    expect(locate(form, 'ghost')).toBeUndefined();
    expect(findField(form, 'ghost')).toBeUndefined();
  });

  it('never mutates the definition it was given', () => {
    const form = inspection();
    const before = JSON.stringify(form);
    addField(form, 'outcome', field('text', 'x'));
    updateField(form, 'reason', (candidate) => ({ ...candidate, required: true }));
    moveField(form, 'reason', 'notes_section', 0);
    remove(form, 'notes');
    duplicate(form, 'checks');
    expect(JSON.stringify(form)).toBe(before);
  });
});

describe('updating', () => {
  it('changes a field but never its id, whatever the update returns', () => {
    const form = ok(
      updateField(inspection(), 'reason', (candidate) => ({
        ...candidate,
        id: 'renamed',
        required: true,
      })),
    );
    expect(findField(form, 'reason')?.required).toBe(true);
    expect(findField(form, 'renamed')).toBeUndefined();
  });

  it('changes a section or page without touching its children or id', () => {
    let form = ok(
      updateSection(inspection(), 'outcome', (candidate) => ({
        ...candidate,
        id: 'x',
        title: { en: 'Outcome' },
      })),
    );
    form = ok(
      updatePage(form, 'checks', (candidate) => ({ ...candidate, title: { en: 'Checks' } })),
    );
    expect(form.pages[0]?.sections[0]).toMatchObject({ id: 'outcome', title: { en: 'Outcome' } });
    expect(form.pages[0]?.sections[0]?.fields).toHaveLength(2);
    expect(form.pages[0]).toMatchObject({ id: 'checks', title: { en: 'Checks' } });
  });

  it('refuses updates to the wrong kind of element', () => {
    expect(isEditError(updateField(inspection(), 'outcome', (candidate) => candidate))).toBe(true);
    expect(isEditError(updateSection(inspection(), 'reason', (candidate) => candidate))).toBe(true);
    expect(isEditError(updatePage(inspection(), 'outcome', (candidate) => candidate))).toBe(true);
  });
});

describe('moving', () => {
  it('reorders a field within its section, and moves it to another', () => {
    const reordered = ok(moveField(inspection(), 'reason', 'outcome', 0));
    expect(reordered.pages[0]?.sections[0]?.fields.map((candidate) => candidate.id)).toEqual([
      'reason',
      'result',
    ]);

    const moved = ok(moveField(inspection(), 'notes', 'signature_section', 0));
    expect(moved.pages[1]?.sections[0]?.fields.map((candidate) => candidate.id)).toEqual([
      'notes',
      'signed',
    ]);
    expect(moved.pages[0]?.sections[1]?.fields).toEqual([]);
  });

  it('moves sections between pages, and pages within the form', () => {
    const moved = ok(moveSection(inspection(), 'notes_section', 'sign_off', 1));
    expect(moved.pages[1]?.sections.map((candidate) => candidate.id)).toEqual([
      'signature_section',
      'notes_section',
    ]);
    expect(
      ok(movePage(inspection(), 'sign_off', 0)).pages.map((candidate) => candidate.id),
    ).toEqual(['sign_off', 'checks']);
  });

  it('refuses to strip a page of its last section by moving it away', () => {
    expect(moveSection(inspection(), 'signature_section', 'checks', 0)).toEqual({
      error: 'last_section',
      page: 'sign_off',
    });
    expect(isEditError(moveSection(inspection(), 'signature_section', 'sign_off', 0))).toBe(false);
  });

  it('refuses a move to nowhere', () => {
    expect(moveField(inspection(), 'reason', 'nowhere', 0)).toEqual({
      error: 'invalid_target',
      id: 'nowhere',
    });
    expect(moveField(inspection(), 'ghost', 'outcome', 0)).toEqual({
      error: 'not_found',
      id: 'ghost',
    });
    expect(moveSection(inspection(), 'outcome', 'nowhere', 0)).toEqual({
      error: 'invalid_target',
      id: 'nowhere',
    });
    expect(moveSection(inspection(), 'ghost', 'checks', 0)).toEqual({
      error: 'not_found',
      id: 'ghost',
    });
    expect(movePage(inspection(), 'ghost', 0)).toEqual({ error: 'not_found', id: 'ghost' });
  });
});

describe('duplicating', () => {
  it('copies a field directly after the original, with a new id', () => {
    const result = duplicate(inspection(), 'reason');
    if (isEditError(result)) throw new Error('unexpected');
    expect(result.copyId).toBe('reason_copy');
    expect(
      result.definition.pages[0]?.sections[0]?.fields.map((candidate) => candidate.id),
    ).toEqual(['result', 'reason', 'reason_copy']);
    // A single copied field still watches the original it was built on.
    expect(findField(result.definition, 'reason_copy')?.visibleWhen).toEqual(
      eq(answer('result'), text('fail')),
    );
  });

  it('points references inside a copied section at the copy, not the original', () => {
    const result = duplicate(inspection(), 'outcome');
    if (isEditError(result)) throw new Error('unexpected');

    const copiedReason = findField(result.definition, 'reason_copy');
    expect(copiedReason?.visibleWhen).toEqual(eq(answer('result_copy'), text('fail')));
    expect(compileDefinition(result.definition).ok).toBe(true);
  });

  it('copies a page with every section and field under new ids, and the result compiles', () => {
    const result = duplicate(inspection(), 'checks');
    if (isEditError(result)) throw new Error('unexpected');
    expect(result.definition.pages.map((candidate) => candidate.id)).toEqual([
      'checks',
      'checks_copy',
      'sign_off',
    ]);
    expect(new Set(allIds(result.definition)).size).toBe(allIds(result.definition).length);
    expect(compileDefinition(result.definition).ok).toBe(true);
  });

  it('carries conditions and calculations on copied sections and pages', () => {
    const base: FormDefinition = {
      schemaVersion: 1,
      title: { en: 'x' },
      pages: [
        page(
          'p',
          [
            section(
              'inputs',
              [
                field('number', 'hours'),
                field('number', 'total', { calculation: answer('hours') }),
              ],
              { visibleWhen: answered('gate') },
            ),
            section('gate_section', [field('checkbox', 'gate')]),
          ],
          { visibleWhen: answered('gate') },
        ),
      ],
    };
    const result = duplicate(base, 'inputs');
    if (isEditError(result)) throw new Error('unexpected');
    const copy = result.definition.pages[0]?.sections[1];
    expect(copy?.visibleWhen).toEqual(answered('gate'));
    expect(findField(result.definition, 'total_copy')).toMatchObject({
      calculation: answer('hours_copy'),
    });

    const pageCopy = duplicate(base, 'p');
    if (isEditError(pageCopy)) throw new Error('unexpected');
    expect(pageCopy.definition.pages[1]?.visibleWhen).toEqual(answered('gate_copy'));
  });

  it('remaps references inside custom rules too', () => {
    const base = fields(
      field('time', 'start'),
      field('time', 'finish', {
        rules: [
          {
            id: 'after',
            assert: {
              kind: 'compare',
              operator: 'gt',
              left: answer('finish'),
              right: answer('start'),
            },
            message: { en: 'x' },
          },
        ],
      }),
    );
    const result = duplicate(base, 'section_1');
    if (isEditError(result)) throw new Error('unexpected');
    expect(findField(result.definition, 'finish_copy')?.rules?.[0]?.assert).toEqual({
      kind: 'compare',
      operator: 'gt',
      left: answer('finish_copy'),
      right: answer('start_copy'),
    });
  });

  it('refuses to duplicate what is not there', () => {
    expect(duplicate(inspection(), 'ghost')).toEqual({ error: 'not_found', id: 'ghost' });
  });
});

describe('removing', () => {
  it('lists every rule that reads what is about to be removed', () => {
    expect(referencesTo(inspection(), ['result'])).toEqual([
      { from: 'reason', where: 'visibleWhen', to: 'result' },
      { from: 'signed', where: 'visibleWhen', to: 'result' },
    ]);
  });

  it('ignores references from inside the removed subtree itself', () => {
    expect(referencesTo(inspection(), subtreeIds(inspection(), 'outcome'))).toEqual([
      { from: 'signed', where: 'visibleWhen', to: 'result' },
    ]);
  });

  it('finds references in calculations, rules and container conditions', () => {
    const form: FormDefinition = {
      schemaVersion: 1,
      title: { en: 'x' },
      pages: [
        page(
          'p',
          [
            section(
              's',
              [
                field('number', 'hours'),
                field('number', 'total', { calculation: answer('hours') }),
                field('text', 't', {
                  rules: [{ id: 'r', assert: answered('hours'), message: { en: 'x' } }],
                }),
              ],
              { visibleWhen: answered('hours') },
            ),
          ],
          { visibleWhen: answered('hours') },
        ),
      ],
    };
    expect(
      referencesTo(form, ['hours']).map((reference) => `${reference.from}:${reference.where}`),
    ).toEqual(['p:visibleWhen', 's:visibleWhen', 'total:calculation', 't:rule']);
  });

  it('removes a field, a section with its fields, and a page with everything in it', () => {
    expect(ids(ok(remove(inspection(), 'reason')))).not.toContain('reason');
    expect(ids(ok(remove(inspection(), 'notes_section')))).not.toContain('notes');
    expect(ids(ok(remove(inspection(), 'sign_off')))).not.toContain('signed');
    expect(subtreeIds(inspection(), 'sign_off')).toEqual([
      'sign_off',
      'signature_section',
      'signed',
    ]);
    expect(subtreeIds(inspection(), 'reason')).toEqual(['reason']);
    expect(subtreeIds(inspection(), 'ghost')).toEqual([]);
  });

  it('refuses to remove the last page or a page’s last section', () => {
    const single = ok(remove(inspection(), 'sign_off'));
    expect(remove(single, 'checks')).toEqual({ error: 'last_page' });
    expect(remove(inspection(), 'signature_section')).toEqual({
      error: 'last_section',
      page: 'sign_off',
    });
    expect(remove(inspection(), 'ghost')).toEqual({ error: 'not_found', id: 'ghost' });
  });

  it('leaves the broken reference for the compiler to name, rather than silently rewriting rules', () => {
    const issues = compileDefinition(ok(remove(inspection(), 'result')));
    expect(issues.ok).toBe(false);
    if (!issues.ok) {
      expect(issues.issues.map((issue) => issue.elements)).toEqual([['result'], ['result']]);
    }
  });
});

describe('any sequence of edits', () => {
  const TYPES: FieldType[] = FIELD_TYPES.map((description) => description.type);

  it('keeps every id unique, and a form with no rules compiles', () => {
    const operation = fc.oneof(
      fc.record({
        op: fc.constant('add' as const),
        type: fc.constantFrom(...TYPES),
        where: fc.nat(),
      }),
      fc.record({ op: fc.constant('section' as const), where: fc.nat() }),
      fc.record({ op: fc.constant('page' as const) }),
      fc.record({
        op: fc.constant('move' as const),
        which: fc.nat(),
        where: fc.nat(),
        at: fc.nat(10),
      }),
      fc.record({ op: fc.constant('duplicate' as const), which: fc.nat() }),
      fc.record({ op: fc.constant('remove' as const), which: fc.nat() }),
    );

    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (operations) => {
        let form = emptyDefinition({ en: 'Generated' });
        for (const step of operations) {
          const everything = allIds(form);
          const sections = form.pages.flatMap((candidate) => candidate.sections.map((s) => s.id));
          const pick = <T>(items: readonly T[], n: number) => items[n % items.length]!;
          let result: EditResult;

          switch (step.op) {
            case 'add': {
              const id = generateId(step.type, 'field', everything);
              result = addField(
                form,
                pick(sections, step.where),
                newField(step.type, id, { en: id }),
              );
              break;
            }
            case 'section':
              result = addSection(
                form,
                pick(form.pages, step.where).id,
                newSection(generateId('section', 'section', everything)),
              );
              break;
            case 'page': {
              const pageId = generateId('page', 'page', everything);
              result = addPage(
                form,
                newPage(pageId, [
                  newSection(generateId('section', 'section', [...everything, pageId])),
                ]),
              );
              break;
            }
            case 'move': {
              const all = fieldsOf(form);
              result =
                all.length === 0
                  ? form
                  : moveField(form, pick(all, step.which).id, pick(sections, step.where), step.at);
              break;
            }
            case 'duplicate': {
              const copied = duplicate(form, pick(everything, step.which));
              result = isEditError(copied) ? copied : copied.definition;
              break;
            }
            case 'remove':
              result = remove(form, pick(everything, step.which));
              break;
          }

          if (!isEditError(result)) {
            form = result;
          }
          const now = allIds(form);
          expect(new Set(now).size).toBe(now.length);
        }

        const compiled = compileDefinition(form);
        expect(compiled.ok || !compiled.issues.some((issue) => issue.code === 'duplicate_id')).toBe(
          true,
        );
        if (
          fieldsOf(form).length > 0 ||
          form.pages.every((candidate) => candidate.sections.length > 0)
        ) {
          expect(compiled.ok).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
