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
import { BlockTree } from './block-editor';
import { historyReducer, initialHistory } from './designer-state';
import {
  columnContainer,
  duplicateBlock,
  insertBlocks,
  locateBlock,
  moveBlock,
  ROOT,
} from './designer-tree';
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
  schemaVersion: 2,
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
            { id: 'gas_off', type: 'information', body: { en: 'Turn the gas off first.' } },
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
        <BlockTree
          blocks={design.blocks}
          context={{
            design,
            form,
            locale: 'en',
            attention: new Map([['qr-1', 'Not in the form any more']]),
            onDuplicate: () => undefined,
            onCopy: () => undefined,
          }}
          onChange={() => undefined}
        />
      </I18nextProvider>,
    );
    expect(html).toContain('Heading');
    expect(html).toContain('Certificate');
    expect(html).toContain('QR code');
    expect(html).toContain('Side by side');
    expect(html).toContain('Duplicate');
    expect(html).toContain('Not in the form any more');
    expect(html).toContain('data-attention="true"');
  });
});

/** A template with a row: two blocks at the top, a row of two columns, one block in the first. */
function withRow(): TemplateDesign {
  return {
    ...emptyDesign(),
    blocks: [
      { type: 'heading', id: 'title', text: { en: 'Title' }, level: 1, align: 'start' },
      { type: 'page_break', id: 'break' },
      {
        type: 'row',
        id: 'row-1',
        columns: [
          { width: 1, blocks: [{ type: 'qr', id: 'qr-1', size: 30, align: 'end' }] },
          { width: 1, blocks: [] },
        ],
      },
      { type: 'divider', id: 'line' },
    ],
  };
}

describe('moving blocks (1.3.0)', () => {
  it('moves within the template and into and out of a row’s columns', () => {
    const design = withRow();
    const down = moveBlock(design.blocks, 'title', { container: ROOT, index: 2 });
    expect(down?.map((block) => block.id)).toEqual(['break', 'row-1', 'title', 'line']);

    const intoRow = moveBlock(design.blocks, 'line', {
      container: columnContainer('row-1', 1),
      index: 0,
    })!;
    expect(intoRow.map((block) => block.id)).toEqual(['title', 'break', 'row-1']);
    expect(locateBlock(intoRow, 'line')).toEqual({
      container: columnContainer('row-1', 1),
      index: 0,
    });

    const outOfRow = moveBlock(design.blocks, 'qr-1', { container: ROOT, index: 0 })!;
    expect(outOfRow.map((block) => block.id)).toEqual(['qr-1', 'title', 'break', 'row-1', 'line']);
  });

  it('keeps rows and page breaks out of columns, and a row out of itself', () => {
    const design = withRow();
    expect(
      moveBlock(design.blocks, 'break', { container: columnContainer('row-1', 0), index: 0 }),
    ).toBeNull();
    expect(
      moveBlock(design.blocks, 'row-1', { container: columnContainer('row-1', 1), index: 0 }),
    ).toBeNull();
    expect(moveBlock(design.blocks, 'title', { container: ROOT, index: 0 })).toBeNull();
  });

  it('duplicates and pastes with ids nothing else has, a row’s blocks included', () => {
    const design = withRow();
    const twice = duplicateBlock(design, 'row-1')!;
    expect(twice.blocks.map((block) => block.id)).toEqual([
      'title',
      'break',
      'row-1',
      'row-2',
      'line',
    ]);
    const copy = twice.blocks[3];
    expect(copy?.type === 'row' && copy.columns[0]?.blocks[0]?.id).toBe('qr-2');
    const parsed = parseDesign(twice);
    expect(parsed.ok).toBe(true);

    const pasted = insertBlocks(design, [design.blocks[0]!, design.blocks[1]!], {
      container: columnContainer('row-1', 1),
      index: 0,
    });
    // A page break cannot stand in a column; the heading can.
    const row = pasted.blocks.find((block) => block.id === 'row-1');
    expect(row?.type === 'row' && row.columns[1]?.blocks.map((block) => block.id)).toEqual([
      'heading-1',
    ]);
  });
});

describe('undo and redo (1.3.0)', () => {
  it('joins typing into one step, keeps other changes apart, and redoes', () => {
    const start = { design: emptyDesign(), name: 'A' };
    let state = initialHistory(start);
    state = historyReducer(state, {
      type: 'edit',
      draft: { ...start, name: 'AB' },
      kind: 'typing',
      at: 1_000,
    });
    state = historyReducer(state, {
      type: 'edit',
      draft: { ...start, name: 'ABC' },
      kind: 'typing',
      at: 1_400,
    });
    expect(state.past).toHaveLength(1);
    const moved = { ...state.present, design: { ...state.present.design, blocks: [] } };
    state = historyReducer(state, { type: 'edit', draft: moved, kind: 'step', at: 1_500 });
    expect(state.past).toHaveLength(2);
    state = historyReducer(state, { type: 'undo' });
    expect(state.present.name).toBe('ABC');
    expect(state.present.design.blocks).toHaveLength(1);
    state = historyReducer(state, { type: 'undo' });
    expect(state.present.name).toBe('A');
    state = historyReducer(state, { type: 'redo' });
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.design.blocks).toHaveLength(0);
    expect(state.future).toHaveLength(0);
  });
});
