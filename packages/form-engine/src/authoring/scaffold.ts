import {
  DEFINITION_SCHEMA_VERSION,
  type FormDefinition,
  type Page,
  type Section,
} from '../definition.js';
import type { Field, FieldOf, FieldType } from '../field-types.js';
import { ELEMENT_ID, type ElementId, type LocalizedText } from '../ids.js';

/**
 * New things, ready to drop onto the canvas.
 *
 * Everything returned here compiles as it stands, so an admin who drags a field
 * in and publishes immediately gets a working form rather than a list of
 * errors about properties they never saw.
 */

/**
 * A stable id derived from a label, unique among `taken`.
 *
 * Derived once, when the element is created, and never again: renaming the
 * label later changes nothing, because the id is what every submission is keyed
 * by. A label with no Latin letters — an Arabic one, say — yields the kind
 * name, so the id is still readable in a CSV header.
 */
export function generateId(
  label: string,
  kind: 'page' | 'section' | 'field',
  taken: Iterable<ElementId>,
): ElementId {
  const used = new Set(taken);
  const base = slug(label) ?? kind;

  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tail = `_${String(suffix)}`;
    const candidate = `${base.slice(0, 64 - tail.length)}${tail}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function slug(label: string): ElementId | undefined {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');

  let candidate = words.join('_').slice(0, 64).replace(/_+$/u, '');
  if (candidate === '') {
    return undefined;
  }
  if (!/^[a-z]/u.test(candidate)) {
    candidate = `f_${candidate}`.slice(0, 64).replace(/_+$/u, '');
  }
  return ELEMENT_ID.test(candidate) ? candidate : undefined;
}

/** Text in the language the admin is building in. */
export function text(locale: string, value: string): LocalizedText {
  return { [locale]: value };
}

const DEFAULT_OPTIONS = (locale: string) => [
  { value: 'option_1', label: text(locale, 'Option 1') },
  { value: 'option_2', label: text(locale, 'Option 2') },
];

/** A field of `type` with everything the type requires, and nothing else set. */
export function newField(
  type: FieldType,
  id: ElementId,
  label: LocalizedText,
  locale = 'en',
): Field {
  const base = { id, label };
  switch (type) {
    case 'decimal':
      return { ...base, type, decimalPlaces: 2 } satisfies FieldOf<'decimal'>;
    case 'rating':
      return { ...base, type, scale: 5 } satisfies FieldOf<'rating'>;
    case 'dropdown':
    case 'radio':
    case 'multi_select':
      return { ...base, type, options: DEFAULT_OPTIONS(locale) };
    default:
      return { ...base, type };
  }
}

export function newSection(id: ElementId, fields: Field[] = []): Section {
  return { id, fields };
}

export function newPage(id: ElementId, sections: Section[]): Page {
  return { id, sections };
}

/** A form with one page, one empty section and a title, which is where every builder session starts. */
export function emptyDefinition(title: LocalizedText): FormDefinition {
  return {
    schemaVersion: DEFINITION_SCHEMA_VERSION,
    title,
    pages: [newPage('page_1', [newSection('section_1')])],
  };
}
