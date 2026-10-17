import {
  checkDesignAgainstForm,
  emptyDesign,
  parseDesign,
  type TemplateDesign,
} from '@integr8/document-render';
import { compileDefinition } from '@integr8/form-engine';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockList } from './block-editor';
import {
  BLOCK_TYPES,
  freshBlockId,
  moved,
  newBlock,
  newField,
  optionsOf,
  questions,
  repeatingSections,
  sectionFields,
} from './designer-model';

/**
 * The PDF designer's model: every block it adds is one the server accepts
 * for a form that has the questions it needs, ids never collide, and the
 * pickers offer the questions each block can show.
 */

const compiled = compileDefinition({
  schemaVersion: 1,
  title: { en: 'Gas safety' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'main',
          fields: [
            { id: 'customer', type: 'text', label: { en: 'Customer' } },
            { id: 'safe', type: 'yes_no', label: { en: 'Safe' } },
            {
              id: 'kind',
              type: 'radio',
              label: { en: 'Appliance' },
              options: [
                { value: 'boiler', label: { en: 'Boiler' } },
                { value: 'cooker', label: { en: 'Cooker' } },
              ],
            },
            { id: 'photos', type: 'photo', label: { en: 'Photos' } },
          ],
        },
        {
          id: 'parts',
          title: { en: 'Parts' },
          repeat: { maxEntries: 20, entryLabel: { en: 'Part' } },
          fields: [
            { id: 'part', type: 'text', label: { en: 'Part' } },
            { id: 'qty', type: 'number', label: { en: 'Qty' } },
          ],
        },
      ],
    },
  ],
});
if (!compiled.ok) {
  throw new Error('the test form does not compile');
}
const form = compiled.form;

describe('new blocks', () => {
  it('are each accepted by the server for a form with the questions they need', () => {
    let design: TemplateDesign = emptyDesign();
    for (const type of BLOCK_TYPES) {
      const id = freshBlockId(design, type);
      design = { ...design, blocks: [...design.blocks, newBlock(type, id, form)] };
    }
    const parsed = parseDesign(design);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
    if (parsed.ok) {
      expect(checkDesignAgainstForm(parsed.design, form)).toEqual([]);
    }
  });

  it('never reuse an id, inside rows included', () => {
    const design = emptyDesign();
    const row = newBlock('row', freshBlockId(design, 'row'), form);
    if (row.type !== 'row') {
      throw new Error('not a row');
    }
    const text = newBlock('text', 'text-1', form);
    const withRow: TemplateDesign = {
      ...design,
      blocks: [
        ...design.blocks,
        { ...row, columns: [{ width: 1, blocks: [text as never] }, row.columns[1]!] },
      ],
    };
    expect(freshBlockId(withRow, 'text')).toBe('text-2');
    expect(freshBlockId(withRow, 'row')).toBe('row-2');
  });
});

describe('the pickers', () => {
  it('offer the questions each block can show', () => {
    expect(questions(form).map((question) => question.id)).toEqual([
      'customer',
      'safe',
      'kind',
      'photos',
    ]);
    expect(questions(form, ['photo', 'signature']).map((question) => question.id)).toEqual([
      'photos',
    ]);
    expect(repeatingSections(form).map((section) => section.id)).toEqual(['parts']);
    expect(sectionFields(form, 'parts').map((question) => question.id)).toEqual(['part', 'qty']);
    expect(optionsOf(form, 'kind').map((option) => option.value)).toEqual(['boiler', 'cooker']);
    expect(optionsOf(form, 'safe').map((option) => option.value)).toEqual([
      'yes',
      'no',
      'not_applicable',
    ]);
  });

  it('gives a new field an unused key, and moves items within bounds', () => {
    const first = newField([]);
    expect(first.key).toBe('field_1');
    expect(newField([first]).key).toBe('field_2');
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });
});

describe('the content list', () => {
  it('names each block and offers to add more', () => {
    const i18n = createI18n({ locale: 'en' });
    const design: TemplateDesign = {
      ...emptyDesign(),
      blocks: [
        { type: 'heading', id: 'title', text: { en: 'Certificate' }, level: 1, align: 'start' },
        { type: 'qr', id: 'qr-1', size: 30, align: 'end' },
      ],
    };
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <BlockList
          blocks={design.blocks}
          context={{ design, form, locale: 'en' }}
          onChange={() => undefined}
        />
      </I18nextProvider>,
    );
    expect(html).toContain('Heading');
    expect(html).toContain('Certificate');
    expect(html).toContain('QR code');
    expect(html).toContain('Side by side');
  });
});
