import { describe, expect, it } from 'vitest';
import { compileDefinition } from '../compile.js';
import type { FormDefinition } from '../definition.js';
import { FORM_TEMPLATES } from '../templates/index.js';
import { answer, eq, text } from '../test-support/builders.js';
import {
  collectTexts,
  lacksLanguage,
  missingTranslations,
  setText,
  withLanguage,
} from './translations.js';

const form = (): FormDefinition => ({
  schemaVersion: 1,
  title: { en: 'Boiler service', ar: 'صيانة الغلاية' },
  pages: [
    {
      id: 'inspection',
      title: { en: 'Inspection' },
      sections: [
        {
          id: 'appliance',
          fields: [
            {
              id: 'result',
              type: 'radio',
              label: { en: 'Result', ar: 'النتيجة' },
              help: { en: 'Pick one' },
              options: [
                { value: 'pass', label: { en: 'Pass', ar: 'ناجح' } },
                { value: 'fail', label: { en: 'Fail' } },
              ],
              rules: [
                {
                  id: 'not_fail',
                  assert: eq(answer('result'), text('pass')),
                  message: { en: 'Must pass', ar: ' ' },
                },
              ],
            },
            {
              id: 'serial',
              type: 'text',
              label: { ar: 'الرقم' },
              pattern: { source: '^[A-Z]+$', message: { en: 'Capitals only' } },
            },
          ],
        },
        {
          id: 'radiators',
          title: { en: 'Radiators', ar: 'المشعات' },
          repeat: { maxEntries: 10, entryLabel: { en: 'Radiator' } },
          fields: [{ id: 'room', type: 'text', label: { en: 'Room', ar: 'الغرفة' } }],
        },
      ],
    },
  ],
});

describe('collectTexts', () => {
  it('finds every text, in reading order, with what it belongs to', () => {
    const found = collectTexts(form()).map((location) => [
      location.pathText,
      location.elementKind,
      location.element ?? null,
      location.property,
      location.detail ?? null,
      location.optional,
    ]);
    expect(found).toEqual([
      ['title', 'form', null, 'title', null, false],
      ['pages[0].title', 'page', 'inspection', 'title', null, true],
      ['pages[0].sections[0].fields[0].label', 'field', 'result', 'label', null, false],
      ['pages[0].sections[0].fields[0].help', 'field', 'result', 'help', null, true],

      [
        'pages[0].sections[0].fields[0].options[0].label',
        'field',
        'result',
        'options.label',
        'pass',
        false,
      ],
      [
        'pages[0].sections[0].fields[0].options[1].label',
        'field',
        'result',
        'options.label',
        'fail',
        false,
      ],
      [
        'pages[0].sections[0].fields[0].rules[0].message',
        'field',
        'result',
        'rules.message',
        'not_fail',
        false,
      ],
      ['pages[0].sections[0].fields[1].label', 'field', 'serial', 'label', null, false],
      [
        'pages[0].sections[0].fields[1].pattern.message',
        'field',
        'serial',
        'pattern.message',
        null,
        true,
      ],
      ['pages[0].sections[1].title', 'section', 'radiators', 'title', null, true],
      [
        'pages[0].sections[1].repeat.entryLabel',
        'section',
        'radiators',
        'repeat.entryLabel',
        null,
        false,
      ],
      ['pages[0].sections[1].fields[0].label', 'field', 'room', 'label', null, false],
    ]);
  });

  it('names the page and section each text is in', () => {
    const room = collectTexts(form()).find((location) => location.element === 'room');
    expect(room).toMatchObject({ page: 'inspection', section: 'radiators' });
    const title = collectTexts(form())[0];
    expect(title).toMatchObject({ page: undefined, section: undefined });
  });

  it('reads a draft that does not compile, and a question of a type it does not know', () => {
    const broken = form() as unknown as { pages: { sections: { fields: unknown[] }[] }[] };
    broken.pages[0]!.sections[0]!.fields.push({
      id: 'later',
      type: 'not_yet_invented',
      label: { en: 'Later' },
      help: { ar: 'لاحقا' },
      somethingNew: { en: 'not a known text' },
    });
    const later = collectTexts(broken as unknown as FormDefinition).filter(
      (location) => location.element === 'later',
    );
    expect(later.map((location) => location.property)).toEqual(['label', 'help']);
  });

  it('finds descriptions and Information blocks (form format 2), and counts them as missing', () => {
    const later = form();
    later.schemaVersion = 2;
    later.pages[0]!.description = { en: 'Before you start', ar: 'قبل أن تبدأ' };
    later.pages[0]!.sections[1]!.description = { en: 'One row per radiator' };
    later.pages[0]!.sections[0]!.fields.splice(1, 0, {
      id: 'isolate',
      type: 'information',
      heading: { en: 'Isolate first' },
      body: { en: 'Turn the supply off.', ar: 'أوقف الإمداد.' },
      style: 'warning',
    });
    const found = collectTexts(later).map((location) => [
      location.pathText,
      location.elementKind,
      location.element ?? null,
      location.property,
      location.optional,
    ]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['pages[0].description', 'page', 'inspection', 'description', true],
        ['pages[0].sections[0].fields[1].heading', 'field', 'isolate', 'heading', true],
        ['pages[0].sections[0].fields[1].body', 'field', 'isolate', 'body', false],
        ['pages[0].sections[1].description', 'section', 'radiators', 'description', true],
      ]),
    );
    // The question after the block is still read as a question.
    expect(found).toContainEqual([
      'pages[0].sections[0].fields[2].label',
      'field',
      'serial',
      'label',
      false,
    ]);
    expect(missingTranslations(later, 'ar').map((location) => location.pathText)).toEqual(
      expect.arrayContaining([
        'pages[0].sections[0].fields[1].heading',
        'pages[0].sections[1].description',
      ]),
    );
    expect(
      missingTranslations(later, 'ar').some((location) => location.pathText.endsWith('body')),
    ).toBe(false);
  });

  it('skips what is not text: ids, rule expressions, option values', () => {
    const withCondition = form();
    withCondition.pages[0]!.sections[1]!.visibleWhen = eq(answer('result'), text('pass'));
    const paths = collectTexts(withCondition).map((location) => location.pathText);
    expect(paths.some((path) => path.includes('visibleWhen') || path.includes('assert'))).toBe(
      false,
    );
  });

  it('lists every text of every library template, all of them in both languages', () => {
    for (const template of FORM_TEMPLATES) {
      const texts = collectTexts(template.definition);
      expect(texts.length).toBeGreaterThan(5);
      expect(missingTranslations(template.definition, 'ar')).toEqual([]);
      expect(missingTranslations(template.definition, 'en')).toEqual([]);
    }
  });
});

describe('missingTranslations', () => {
  it('lists the texts with no Arabic, counting a blank one as missing', () => {
    expect(missingTranslations(form(), 'ar').map((location) => location.pathText)).toEqual([
      'pages[0].title',
      'pages[0].sections[0].fields[0].help',
      'pages[0].sections[0].fields[0].options[1].label',
      'pages[0].sections[0].fields[0].rules[0].message',
      'pages[0].sections[0].fields[1].pattern.message',
      'pages[0].sections[1].repeat.entryLabel',
    ]);
    expect(missingTranslations(form(), 'en').map((location) => location.pathText)).toEqual([
      'pages[0].sections[0].fields[1].label',
    ]);
  });

  it('agrees with lacksLanguage', () => {
    expect(lacksLanguage({ en: 'x' }, 'ar')).toBe(true);
    expect(lacksLanguage({ en: 'x', ar: '  ' }, 'ar')).toBe(true);
    expect(lacksLanguage({ ar: 'س' }, 'ar')).toBe(false);
  });
});

describe('setText and withLanguage', () => {
  it('replaces one text and leaves the rest of the definition alone', () => {
    const before = form();
    const target = collectTexts(before).find(
      (location) => location.property === 'options.label' && location.detail === 'fail',
    )!;
    const after = setText(before, target.path, withLanguage(target.text, 'ar', 'راسب'));
    expect(
      collectTexts(after).find((location) => location.pathText === target.pathText)?.text,
    ).toEqual({ en: 'Fail', ar: 'راسب' });
    expect(before.pages[0]!.sections[0]!.fields[0]).not.toBe(
      after.pages[0]!.sections[0]!.fields[0],
    );
    expect(before.pages[0]!.sections[1]).toBe(after.pages[0]!.sections[1]);
    expect(compileDefinition(after).ok).toBe(true);
  });

  it('removes an optional text when its last language is cleared', () => {
    const before = form();
    const help = collectTexts(before).find((location) => location.property === 'help')!;
    const after = setText(before, help.path, withLanguage(help.text, 'en', ''));
    expect('help' in after.pages[0]!.sections[0]!.fields[0]!).toBe(false);
  });

  it('ignores a path that is not there', () => {
    const before = form();
    expect(setText(before, ['pages', 4, 'title'], { en: 'x' })).toEqual(before);
  });

  it('withLanguage drops a blank language and returns undefined when none is left', () => {
    expect(withLanguage({ en: 'A' }, 'ar', 'ب')).toEqual({ en: 'A', ar: 'ب' });
    expect(withLanguage({ en: 'A', ar: 'ب' }, 'ar', ' ')).toEqual({ en: 'A' });
    expect(withLanguage({ en: 'A' }, 'en', '')).toBeUndefined();
  });
});
