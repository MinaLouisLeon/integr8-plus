import {
  CONDITION_OPERATORS,
  FIELD_TYPES,
  fieldSchema,
  SUBMISSION_ISSUE_CODES,
} from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { en } from './messages/en.js';

/**
 * The builder's vocabulary is the engine's, in words.
 *
 * Every field type, purpose, comparison and property the engine defines is
 * something the builder shows by name. A new one without words here would
 * render as a raw key in front of a company admin — so these fail first.
 */

const COMMON = new Set([
  'id',
  'type',
  'label',
  'help',
  'required',
  'readOnly',
  'visibleWhen',
  'rules',
]);

describe('form builder messages', () => {
  it('names every field type and every palette group', () => {
    expect(FIELD_TYPES.filter(({ type }) => !(type in en.forms.fieldType))).toEqual([]);
    const purposes = [...new Set(FIELD_TYPES.map(({ purpose }) => purpose))];
    expect(purposes.filter((purpose) => !(purpose in en.forms.palette.purpose))).toEqual([]);
  });

  it('phrases every comparison a condition can use', () => {
    expect(
      CONDITION_OPERATORS.filter((operator) => !(operator in en.forms.conditions.operator)),
    ).toEqual([]);
  });

  it('labels every property any field type declares', () => {
    const properties = new Set(
      fieldSchema.options
        .flatMap((schema) => Object.keys(schema.shape))
        .filter((key) => !COMMON.has(key)),
    );
    expect([...properties].filter((property) => !(property in en.forms.config.property))).toEqual(
      [],
    );
  });

  it('explains every reason the server gives for refusing a test fill', () => {
    expect(SUBMISSION_ISSUE_CODES.filter((code) => !(code in en.forms.preview.issue))).toEqual([]);
  });
});
