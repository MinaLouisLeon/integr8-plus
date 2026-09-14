import { describe, expect, it } from 'vitest';
import type { FormDefinition } from './definition.js';
import { FIELD_TYPES } from './field-types.js';
import { mediaReferences, REPORTABLE_TYPES, reportableFields } from './reporting.js';
import { newField } from './authoring/scaffold.js';

const everyType = (): FormDefinition => ({
  schemaVersion: 1,
  title: { en: 'All' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: FIELD_TYPES.map(({ type }) => newField(type, `f_${type}`, { en: type })),
        },
      ],
    },
  ],
});

describe('reportable fields', () => {
  it('decides every field type in the registry', () => {
    expect(Object.keys(REPORTABLE_TYPES).sort()).toEqual(
      FIELD_TYPES.map(({ type }) => type).sort(),
    );
  });

  it('reports comparable values, in reading order, and leaves out prose and evidence', () => {
    expect(reportableFields(everyType())).toEqual([
      { field: 'f_text', type: 'text', multiple: false },
      { field: 'f_barcode', type: 'text', multiple: false },
      { field: 'f_number', type: 'number', multiple: false },
      { field: 'f_decimal', type: 'number', multiple: false },
      { field: 'f_rating', type: 'number', multiple: false },
      { field: 'f_date', type: 'date', multiple: false },
      { field: 'f_time', type: 'time', multiple: false },
      { field: 'f_datetime', type: 'datetime', multiple: false },
      { field: 'f_dropdown', type: 'text', multiple: false },
      { field: 'f_radio', type: 'text', multiple: false },
      { field: 'f_multi_select', type: 'text', multiple: true },
      { field: 'f_checkbox', type: 'boolean', multiple: false },
      { field: 'f_yes_no', type: 'text', multiple: false },
    ]);
  });
});

describe('media references', () => {
  const photo = {
    mediaId: '6f1c1d3a-8b8e-4c3b-9a55-0d8b9a3d2f11',
    contentType: 'image/jpeg',
    byteSize: 1200,
  };
  const signature = {
    mediaId: '2b9b5b1e-1f5e-4a77-8f0e-6f7a2c3d4e5f',
    contentType: 'image/png',
    byteSize: 800,
  };

  it('lists every well-formed reference, with the field it belongs to', () => {
    expect(
      mediaReferences(everyType(), {
        f_photo: [photo, photo],
        f_signature: signature,
        f_file: [],
        f_text: photo,
      }),
    ).toEqual([
      { field: 'f_signature', media: signature },
      { field: 'f_photo', media: photo },
      { field: 'f_photo', media: photo },
    ]);
  });

  it('ignores what is not a reference; shape is the validator’s job, not this list’s', () => {
    expect(
      mediaReferences(everyType(), { f_photo: [{ mediaId: 'nope' }], f_signature: 'x' }),
    ).toEqual([]);
  });

  it('does not read an inherited property as an answer', () => {
    expect(
      mediaReferences(
        everyType(),
        Object.create({ f_signature: signature }) as Record<string, unknown>,
      ),
    ).toEqual([]);
  });
});
