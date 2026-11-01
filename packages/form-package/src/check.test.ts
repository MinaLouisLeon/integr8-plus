import { describe, expect, it } from 'vitest';
import { checkFormPackage } from './index.js';
import { BACKGROUND_ID, boilerDefinition, boilerDesign, LOGO_ID } from './test-support/fixtures.js';

const files = [{ id: BACKGROUND_ID }, { id: LOGO_ID }];

describe('checkFormPackage', () => {
  it('passes a form that publishes with templates that save', () => {
    expect(
      checkFormPackage({
        form: boilerDefinition(),
        templates: [{ name: 'Service report', design: boilerDesign() }],
        files,
      }),
    ).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('names a template’s question the form does not have', () => {
    const design = boilerDesign();
    design.blocks.push({
      type: 'field',
      id: 'ghost',
      fieldId: 'flue_temperature',
      layout: 'inline',
    });
    const check = checkFormPackage({
      form: boilerDefinition(),
      templates: [{ name: 'Service report', design }],
    });
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      {
        entry: 'templates/1.json',
        path: 'design.blocks.ghost',
        code: 'unknown_field',
        message: 'The form has no field "flue_temperature".',
      },
    ]);
  });

  it('names a question shown the wrong way', () => {
    const design = boilerDesign();
    design.blocks.push({
      type: 'image',
      id: 'not_a_photo',
      source: { kind: 'answer', fieldId: 'serial_number' },
      width: 40,
      align: 'start',
    });
    const check = checkFormPackage({
      form: boilerDefinition(),
      templates: [{ name: 'X', design }],
    });
    expect(check.problems).toMatchObject([
      { entry: 'templates/1.json', path: 'design.blocks.not_a_photo', code: 'wrong_field_type' },
    ]);
  });

  it('names every problem that stops the form publishing, with its path and elements', () => {
    const definition = boilerDefinition();
    const fields = definition.pages[0]?.sections[0]?.fields ?? [];
    // The serial number question again, under the same answer key.
    fields.push(structuredClone(fields[0]!));
    const check = checkFormPackage({
      form: definition,
      templates: [{ name: 'Service report', design: boilerDesign() }],
    });
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatchObject({
      entry: 'form.json',
      code: 'duplicate_id',
      elements: ['serial_number'],
    });
    expect(check.problems[0]?.path).toMatch(/^definition\.pages\[0\]/u);
    // The templates wait for a form that compiles.
    expect(check.warnings).toMatchObject([{ code: 'templates_not_checked' }]);
  });

  it('reports a form that is not even a draft, and a design too new', () => {
    const check = checkFormPackage({
      form: { pages: [] },
      templates: [{ name: '', design: { schemaVersion: 9 } }],
    });
    expect(check.problems.map((problem) => problem.code)).toEqual([
      'package_form_invalid',
      'package_template_invalid',
      'package_too_new',
    ]);
  });

  it('reports a design the designer cannot read', () => {
    const check = checkFormPackage({
      form: boilerDefinition(),
      templates: [{ name: 'Broken', design: { schemaVersion: 2, blocks: 'none' } }],
    });
    expect(check.problems.length).toBeGreaterThan(0);
    expect(check.problems.every((problem) => problem.entry === 'templates/1.json')).toBe(true);
    expect(check.problems.map((problem) => problem.path)).toContain('design.page');
  });

  it('warns of missing translations, and of a title that differs from the manifest', () => {
    const definition = boilerDefinition();
    definition.title = { en: 'Boiler service' };
    const check = checkFormPackage({
      form: definition,
      manifest: { form: { title: { en: 'Boiler check' } } },
    });
    expect(check.ok).toBe(true);
    expect(check.warnings).toEqual([
      {
        entry: 'form.json',
        path: 'definition.title',
        code: 'translation_missing',
        message: 'This text has no Arabic.',
      },
      expect.objectContaining({ entry: 'manifest.json', code: 'title_mismatch' }),
    ]);
  });

  it('checks the pictures when they are given', () => {
    const stray = '55555555-5555-4555-8555-555555555555';
    const check = checkFormPackage({
      form: boilerDefinition(),
      templates: [{ name: 'Service report', design: boilerDesign() }],
      files: [{ id: BACKGROUND_ID }, { id: stray }],
    });
    expect(check.problems).toMatchObject([
      { entry: 'templates/1.json', code: 'file_missing' },
      { entry: 'files', path: stray, code: 'file_unused' },
    ]);
  });
});
