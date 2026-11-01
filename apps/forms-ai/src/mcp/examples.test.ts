import { checkFormPackage } from '@integr8/form-package';
import { describe, expect, it } from 'vitest';
import { EXAMPLES, findExample, type FormExample } from './examples.js';

describe('the examples', () => {
  it('has the six library forms', () => {
    expect(
      EXAMPLES.filter((example) => example.description.startsWith('Library form')),
    ).toHaveLength(6);
  });

  it.each(
    EXAMPLES.filter((example) => example.kind === 'form').map((example) => [example.key, example]),
  )('form %s would publish, with every text in English and Arabic', (_key, example) => {
    const check = checkFormPackage({ form: example.definition });
    expect(check.problems).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it.each(
    EXAMPLES.flatMap((example) =>
      example.kind === 'pdf_template' ? [[example.key, example]] : [],
    ),
  )('PDF template %s saves against its form', (_key, example) => {
    if (example.kind !== 'pdf_template') {
      throw new Error('not a template');
    }
    const form = findExample(example.form);
    expect(form?.kind).toBe('form');
    const check = checkFormPackage({
      form: (form as FormExample).definition,
      templates: [{ name: example.name, design: example.design }],
      files: [],
    });
    expect(check.problems).toEqual([]);
  });

  it('uses version 2 only where a 1.3.0 feature needs it', () => {
    const cooling = findExample('cooling_plant_inspection') as FormExample;
    expect((cooling.definition as { schemaVersion: number }).schemaVersion).toBe(2);
  });
});
