import { FIELD_TYPES, newField } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { editorFor, PALETTE, specificProperties } from './catalog';

describe('the palette', () => {
  it('offers every field type exactly once, grouped by purpose', () => {
    const offered = PALETTE.flatMap((group) => group.types.map((description) => description.type));
    expect([...offered].sort()).toEqual(FIELD_TYPES.map((description) => description.type).sort());
    expect(PALETTE.map((group) => group.purpose)).toEqual([
      'writing',
      'measuring',
      'scheduling',
      'choosing',
      'evidence',
      'location',
    ]);
  });
});

describe('the configuration panel', () => {
  it('has an editor for every property of every field type in the registry', () => {
    const missing = FIELD_TYPES.flatMap(({ type }) =>
      specificProperties(type)
        .filter((property) => editorFor(type, property) === undefined)
        .map((property) => `${type}.${property}`),
    );
    expect(missing).toEqual([]);
  });

  it('reads the properties from the schema, in its order', () => {
    expect(specificProperties('text')).toEqual(['minLength', 'maxLength', 'pattern', 'default']);
    expect(specificProperties('signature')).toEqual([]);
  });

  it('edits a bound the way the field stores it', () => {
    expect(editorFor('number', 'min')).toBe('integer');
    expect(editorFor('decimal', 'min')).toBe('decimal');
    expect(editorFor('date', 'earliest')).toBe('date');
    expect(editorFor('datetime', 'default')).toBe('datetime');
    expect(editorFor('radio', 'default')).toBe('choice');
    expect(editorFor('multi_select', 'default')).toBe('choices');
  });

  it('lists only properties a new field of that type can carry', () => {
    for (const { type } of FIELD_TYPES) {
      const field = newField(type, 'f', { en: 'F' }) as unknown as Record<string, unknown>;
      for (const property of Object.keys(field)) {
        if (!['id', 'type', 'label'].includes(property)) {
          expect(specificProperties(type)).toContain(property);
        }
      }
    }
  });
});
