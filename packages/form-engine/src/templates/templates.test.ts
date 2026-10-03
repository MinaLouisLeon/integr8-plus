import { describe, expect, it } from 'vitest';
import { compileDefinition } from '../compile.js';
import { validateForm } from '../validation.js';
import { FORM_TEMPLATES } from './index.js';

/**
 * A template is the first form many companies see. One that does not compile
 * would be refused the moment an admin cloned it and pressed publish — so every
 * template is compiled here, and a broken one fails this package's build.
 */
describe('the global template library', () => {
  it.each(FORM_TEMPLATES.map((template) => [template.key, template] as const))(
    '%s compiles',
    (_key, template) => {
      const result = compileDefinition(template.definition);
      if (!result.ok) {
        throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'));
      }
      expect(result.ok).toBe(true);
    },
  );

  it('has unique keys that are usable as database keys', () => {
    const keys = FORM_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
    }
  });

  it('is written in English and Arabic throughout', () => {
    const labels: Record<string, string>[] = [];
    const collect = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (typeof record.en === 'string') {
          labels.push(record as Record<string, string>);
          return;
        }
        Object.values(record).forEach(collect);
      }
    };
    collect(FORM_TEMPLATES);

    expect(labels.length).toBeGreaterThan(40);
    for (const label of labels) {
      expect(label.ar, `no Arabic for "${label.en ?? ''}"`).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it('asks for something on a blank form, rather than being submittable empty', () => {
    for (const template of FORM_TEMPLATES) {
      const result = compileDefinition(template.definition);
      if (result.ok) {
        expect(validateForm(result.form, {}).valid, template.key).toBe(false);
      }
    }
  });
});
