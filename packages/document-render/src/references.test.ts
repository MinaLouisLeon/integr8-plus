import { compileDefinition, type CompiledForm } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { checkDesignAgainstForm, emptyDesign, parseDesign, type TemplateDesign } from './design.js';
import {
  automaticMapping,
  designReferences,
  matchDesignReferences,
  referenceCandidates,
  referencedFileIds,
  replaceFileIds,
  rewriteDesignReferences,
  unresolvedReferences,
} from './references.js';

/**
 * Moving a PDF template to another form (decision 10): finding what it names,
 * matching that in the other form, and rewriting it.
 */

const BACKGROUND = '0b5e8f8e-0d7c-4c5c-9c1e-2f3c4d5e6f70';
const STAMP = '1c6f9a9f-1e8d-4d6d-8d2f-3a4d5e6f7a81';

function compile(definition: unknown): CompiledForm {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.form;
}

/** The form the template was designed for. */
const source = compile({
  schemaVersion: 1,
  title: { en: 'Boiler service' },
  pages: [
    {
      id: 'main',
      sections: [
        {
          id: 'details',
          fields: [
            { id: 'customer', type: 'text', label: { en: 'Customer', ar: 'العميل' } },
            { id: 'safe', type: 'yes_no', label: { en: 'Safe to use' } },
            {
              id: 'kind',
              type: 'radio',
              label: { en: 'Kind' },
              options: [
                { value: 'combi', label: { en: 'Combi' } },
                { value: 'system', label: { en: 'System' } },
              ],
            },
            { id: 'pressure', type: 'decimal', decimalPlaces: 1, label: { en: 'Pressure' } },
            { id: 'photos', type: 'photo', label: { en: 'Photos' } },
            { id: 'notes', type: 'long_text', label: { en: 'Notes' } },
          ],
        },
        {
          id: 'radiators',
          title: { en: 'Radiators', ar: 'المشعات' },
          repeat: { maxEntries: 10, entryLabel: { en: 'Radiator' } },
          fields: [
            { id: 'room', type: 'text', label: { en: 'Room' } },
            { id: 'bled', type: 'checkbox', label: { en: 'Bled' } },
          ],
        },
      ],
    },
  ],
});

/** Another form of the same company, built separately. */
const target = compile({
  schemaVersion: 1,
  title: { en: 'Annual inspection' },
  pages: [
    {
      id: 'p1',
      sections: [
        {
          id: 's1',
          fields: [
            // Same key, same kind of answer.
            { id: 'customer', type: 'text', label: { en: 'Client' } },
            // Same key, but a number: does not fit a yes/no.
            { id: 'safe', type: 'number', label: { en: 'Safety score' } },
            // Worded the same in Arabic, under another key.
            {
              id: 'appliance_safe',
              type: 'yes_no',
              label: { en: 'Appliance OK', ar: 'Safe to use' },
            },
            {
              id: 'boiler_kind',
              type: 'dropdown',
              label: { en: 'Kind' },
              options: [
                { value: 'combi', label: { en: 'Combi' } },
                { value: 'system', label: { en: 'System' } },
                { value: 'regular', label: { en: 'Regular' } },
              ],
            },
            { id: 'pressure_bar', type: 'number', label: { en: 'Pressure reading' } },
            { id: 'evidence', type: 'photo', label: { en: 'Evidence' } },
          ],
        },
        {
          id: 'heaters',
          title: { en: 'Radiators' },
          repeat: { maxEntries: 10, entryLabel: { en: 'Heater' } },
          fields: [
            { id: 'location', type: 'text', label: { en: 'Room' } },
            { id: 'bled_ok', type: 'checkbox', label: { en: 'Bled' } },
          ],
        },
      ],
    },
  ],
});

function design(): TemplateDesign {
  const parsed = parseDesign({
    ...emptyDesign(),
    page: {
      ...emptyDesign().page,
      background: { fileId: BACKGROUND },
      footer: { pageNumbers: true, text: { en: 'Notes: {{answer.notes}}' } },
    },
    fields: [
      {
        key: 'client',
        label: { en: 'Client' },
        source: { kind: 'answer', fieldId: 'customer' },
        lookup: 'key',
      },
      {
        key: 'notes_field',
        label: { en: 'Notes' },
        source: { kind: 'answer', fieldId: 'notes' },
        lookup: 'confirm',
      },
    ],
    blocks: [
      { type: 'heading', id: 'title', text: { en: 'Service for {{ answer.customer }}' } },
      { type: 'field', id: 'safe_line', fieldId: 'safe' },
      { type: 'checkbox', id: 'combi_box', fieldId: 'kind', option: 'combi' },
      { type: 'options', id: 'kind_list', fieldId: 'kind' },
      {
        type: 'fields_table',
        id: 'readings',
        rows: [{ fieldId: 'pressure' }, { fieldId: 'notes' }],
      },
      {
        type: 'repeat_table',
        id: 'rads',
        sectionId: 'radiators',
        columns: [{ fieldId: 'room' }, { fieldId: 'bled' }],
      },
      {
        type: 'row',
        id: 'pictures',
        columns: [
          {
            blocks: [{ type: 'image', id: 'photo', source: { kind: 'answer', fieldId: 'photos' } }],
          },
          { blocks: [{ type: 'image', id: 'stamp', source: { kind: 'file', fileId: STAMP } }] },
        ],
      },
      {
        type: 'text',
        id: 'remarks',
        text: { en: 'Remarks: {{answer.notes}}', ar: '{{answer.notes}}' },
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  return parsed.design;
}

describe('what a template names', () => {
  it('finds every reference, wherever it is, sections first', () => {
    const references = designReferences(design());
    expect(references[0]).toMatchObject({ id: 'radiators', kind: 'section', uses: ['section'] });
    const byId = new Map(references.map((reference) => [reference.id, reference]));
    expect(byId.get('customer')?.uses.sort()).toEqual(['answer', 'placeholder']);
    expect(byId.get('notes')?.uses.sort()).toEqual(['answer', 'placeholder']);
    expect(byId.get('kind')).toMatchObject({ uses: ['checkbox', 'options'], options: ['combi'] });
    expect(byId.get('photos')?.uses).toEqual(['image']);
    expect(byId.get('room')).toMatchObject({ section: 'radiators', uses: ['answer'] });
    expect(byId.get('bled')).toMatchObject({ section: 'radiators' });
    expect([...byId.keys()].sort()).toEqual(
      [
        'bled',
        'customer',
        'kind',
        'notes',
        'photos',
        'pressure',
        'radiators',
        'room',
        'safe',
      ].sort(),
    );
  });

  it('finds every picture the design uses', () => {
    expect(referencedFileIds(design()).sort()).toEqual([BACKGROUND, STAMP].sort());
  });
});

describe('matching to another form', () => {
  const matches = () =>
    new Map(
      matchDesignReferences(design(), source, target).map((entry) => [entry.reference.id, entry]),
    );

  it('matches the same answer key first, when its question fits', () => {
    expect(matches().get('customer')).toMatchObject({ match: 'customer', by: 'key' });
  });

  it('matches the same wording, in either language, when the key does not fit', () => {
    // "safe" is a number in the target; the yes/no worded "Safe to use" in Arabic stands in.
    expect(matches().get('safe')).toMatchObject({ match: 'appliance_safe', by: 'wording' });
    expect(matches().get('kind')).toMatchObject({ match: 'boiler_kind', by: 'wording' });
    expect(matches().get('radiators')).toMatchObject({ match: 'heaters', by: 'wording' });
    // Columns match within the section their table now shows.
    expect(matches().get('room')).toMatchObject({ match: 'location', by: 'wording' });
    expect(matches().get('bled')).toMatchObject({ match: 'bled_ok', by: 'wording' });
  });

  it('leaves for a person what matches neither way, with what could stand in', () => {
    const pressure = matches().get('pressure');
    expect(pressure).toMatchObject({ match: null, by: null });
    // A decimal may become a number; a photo may not stand in for a number.
    expect(pressure?.candidates).toEqual(['safe', 'pressure_bar']);
    expect(matches().get('photos')).toMatchObject({ match: null, candidates: ['evidence'] });
    // Long text may become text.
    expect(matches().get('notes')).toMatchObject({ match: null, candidates: ['customer'] });
  });

  it('offers only questions that can take the use', () => {
    const kind = designReferences(design()).find((reference) => reference.id === 'kind');
    // A check box on "combi" needs a choice with that option.
    expect(kind === undefined ? [] : referenceCandidates(kind, source, target)).toEqual([
      'boiler_kind',
    ]);
    const room = designReferences(design()).find((reference) => reference.id === 'room');
    // A column has nowhere to go until its section does.
    expect(room === undefined ? [] : referenceCandidates(room, source, target, null)).toEqual([]);
    expect(room === undefined ? [] : referenceCandidates(room, source, target, 'heaters')).toEqual([
      'location',
    ]);
  });

  it('says what is still undecided', () => {
    const all = matchDesignReferences(design(), source, target);
    const mapping = automaticMapping(all);
    expect(
      unresolvedReferences(
        all.map((entry) => entry.reference),
        mapping,
      )
        .map((reference) => reference.id)
        .sort(),
    ).toEqual(['notes', 'photos', 'pressure']);
    // Taking out a section's table decides its columns too.
    expect(
      unresolvedReferences(
        all.map((entry) => entry.reference),
        { radiators: null },
      ).map((reference) => reference.id),
    ).not.toContain('room');
  });
});

describe('rewriting', () => {
  const mapping = {
    customer: 'customer',
    safe: 'appliance_safe',
    kind: 'boiler_kind',
    pressure: 'pressure_bar',
    notes: null,
    photos: 'evidence',
    radiators: 'heaters',
    room: 'location',
    bled: 'bled_ok',
  };

  it('renames every reference and takes out what used a removed one', () => {
    const rewritten = rewriteDesignReferences(design(), mapping);
    const ids = (blocks: readonly { id: string }[]) => blocks.map((block) => block.id);
    // The text that printed only the notes goes; the heading keeps its placeholder, renamed.
    expect(ids(rewritten.blocks)).toEqual([
      'title',
      'safe_line',
      'combi_box',
      'kind_list',
      'readings',
      'rads',
      'pictures',
    ]);
    expect(rewritten.blocks[0]).toMatchObject({ text: { en: 'Service for {{answer.customer}}' } });
    // A row of a table of fields goes on its own.
    expect(rewritten.blocks[4]).toMatchObject({ rows: [{ fieldId: 'pressure_bar' }] });
    expect(rewritten.blocks[5]).toMatchObject({
      sectionId: 'heaters',
      columns: [{ fieldId: 'location' }, { fieldId: 'bled_ok' }],
    });
    // The document field taken from the notes goes; its lookup role with it.
    expect(rewritten.fields.map((field) => field.key)).toEqual(['client']);
    // A placeholder in the footer cannot take its footer out: it is removed from the text.
    expect(rewritten.page.footer.text).toEqual({ en: 'Notes: ' });
    // Pictures uploaded for the template are not answers: untouched.
    expect(referencedFileIds(rewritten).sort()).toEqual([BACKGROUND, STAMP].sort());

    // And the result is a design the target accepts.
    const parsed = parseDesign(rewritten);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? checkDesignAgainstForm(parsed.design, target) : ['not parsed']).toEqual([]);
  });

  it('takes out a table with its last row, and a section’s table with its section', () => {
    const rewritten = rewriteDesignReferences(design(), {
      ...mapping,
      pressure: null,
      radiators: null,
    });
    expect(rewritten.blocks.map((block) => block.id)).not.toContain('readings');
    expect(rewritten.blocks.map((block) => block.id)).not.toContain('rads');
  });

  it('drops the second lookup field’s role when the first one goes', () => {
    const rewritten = rewriteDesignReferences(design(), { customer: null });
    expect(rewritten.fields).toMatchObject([{ key: 'notes_field', lookup: 'none' }]);
    expect(parseDesign(rewritten).ok).toBe(true);
  });

  it('leaves the design it was given alone, and what the mapping does not name', () => {
    const original = design();
    const before = JSON.stringify(original);
    const rewritten = rewriteDesignReferences(original, {});
    expect(JSON.stringify(original)).toBe(before);
    expect(rewritten).toEqual(original);
  });

  it('swaps the pictures for their copies', () => {
    const copy = 'ffffffff-0000-4000-8000-000000000001';
    const swapped = replaceFileIds(design(), new Map([[STAMP, copy]]));
    expect(referencedFileIds(swapped).sort()).toEqual([BACKGROUND, copy].sort());
  });
});
