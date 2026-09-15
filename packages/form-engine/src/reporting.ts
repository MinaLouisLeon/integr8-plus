import type { FormDefinition } from './definition.js';
import type { Answers } from './evaluate.js';
import { ownAnswer, storedEntries } from './evaluate.js';
import { type FieldType, type MediaReference, mediaReferenceSchema } from './field-types.js';
import type { ElementId } from './ids.js';

/**
 * What a published version makes searchable, and what it points at outside itself.
 *
 * Both are decided from the definition alone, once, when a version is published —
 * so every submission against that version is indexed the same way for as long
 * as it exists, and changing the rule later changes future versions only.
 */

/** How a reportable answer is stored for filtering. */
export type ReportableType = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'boolean';

export interface ReportableField {
  field: ElementId;
  type: ReportableType;
  /** A multi-select contributes one row per chosen option. */
  multiple: boolean;
  /**
   * For a field of a repeatable section: that section, whose entries each
   * contribute their own rows (P13b). Absent for every other field, so versions
   * published before entries existed read the same.
   */
  section?: ElementId;
}

/**
 * The kind of value each field type reports as, or `null` for none.
 *
 * Not reportable: long text, which is prose that full-text search covers and a
 * column filter does not; and signatures, photos, files and locations, which are
 * evidence to look at, not values to compare.
 */
export const REPORTABLE_TYPES: Readonly<Record<FieldType, ReportableType | null>> = Object.freeze({
  text: 'text',
  long_text: null,
  barcode: 'text',
  number: 'number',
  decimal: 'number',
  rating: 'number',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  dropdown: 'text',
  radio: 'text',
  multi_select: 'text',
  checkbox: 'boolean',
  yes_no: 'text',
  signature: null,
  photo: null,
  file: null,
  gps: null,
});

/** Every field whose answers can be filtered on, in reading order. */
export function reportableFields(definition: FormDefinition): ReportableField[] {
  return definition.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.fields.flatMap((field): ReportableField[] => {
        const type = REPORTABLE_TYPES[field.type];
        return type === null
          ? []
          : [
              {
                field: field.id,
                type,
                multiple: field.type === 'multi_select',
                ...(section.repeat === undefined ? {} : { section: section.id }),
              },
            ];
      }),
    ),
  );
}

export interface FieldMedia {
  field: ElementId;
  media: MediaReference;
  /** For a field of a repeatable section: the entry the file is in. */
  entry?: string;
}

/**
 * Every uploaded file the answers refer to.
 *
 * The engine checks that a reference is well-formed and within the field's
 * limits; it cannot know whether the file exists. The server takes this list and
 * checks each one against what was actually uploaded, by this company, with this
 * type and size — so a submission cannot claim a photo it never sent.
 */
export function mediaReferences(definition: FormDefinition, answers: Answers): FieldMedia[] {
  const found: FieldMedia[] = [];
  for (const page of definition.pages) {
    for (const section of page.sections) {
      // A repeatable section's files are in its entries, each answer in turn.
      const sets: { values: Answers; entry: string | undefined }[] =
        section.repeat === undefined
          ? [{ values: answers, entry: undefined }]
          : storedEntries(answers, section.id).map((entry) => ({
              values: entry.values,
              entry: entry.id,
            }));
      for (const { values, entry } of sets) {
        for (const field of section.fields) {
          if (field.type !== 'signature' && field.type !== 'photo' && field.type !== 'file') {
            continue;
          }
          const value = ownAnswer(values, field.id);
          const candidates = Array.isArray(value) ? value : value === undefined ? [] : [value];
          for (const candidate of candidates) {
            const parsed = mediaReferenceSchema.safeParse(candidate);
            if (parsed.success) {
              found.push({
                field: field.id,
                media: parsed.data,
                ...(entry === undefined ? {} : { entry }),
              });
            }
          }
        }
      }
    }
  }
  return found;
}
