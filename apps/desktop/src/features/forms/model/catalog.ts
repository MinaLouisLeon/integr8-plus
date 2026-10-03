import {
  FIELD_TYPES,
  fieldSchema,
  type FieldPurpose,
  type FieldType,
  type FieldTypeDescription,
} from '@integr8/form-engine';

/**
 * What the palette offers and what the configuration panel edits, read from the
 * engine's field type registry rather than restated here.
 *
 * The palette groups types by purpose — "choosing", "evidence" — because a
 * person building an inspection thinks "I need them to pick one", not "I need
 * an enum". The panel lists a type's properties straight from its schema, so a
 * property P06 adds shows up in the builder or fails this app's tests; it
 * cannot silently be uneditable.
 */

/** Every field has these, and the panel shows them in its own sections. */
export const COMMON_PROPERTIES = [
  'id',
  'type',
  'label',
  'help',
  'required',
  'readOnly',
  'visibleWhen',
  'rules',
] as const;

export type PropertyEditor =
  | 'integer'
  | 'decimal'
  | 'text'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'choice'
  | 'choices'
  | 'yes_no'
  | 'options'
  | 'pattern'
  | 'calculation'
  | 'megabytes'
  | 'media_types';

export interface PaletteGroup {
  purpose: FieldPurpose;
  types: readonly FieldTypeDescription[];
}

export const PALETTE: readonly PaletteGroup[] = (() => {
  const groups: PaletteGroup[] = [];
  for (const description of FIELD_TYPES) {
    const group = groups.find((candidate) => candidate.purpose === description.purpose);
    if (group === undefined) {
      groups.push({ purpose: description.purpose, types: [description] });
    } else {
      (group.types as FieldTypeDescription[]).push(description);
    }
  }
  return groups;
})();

const SHAPES: ReadonlyMap<FieldType, readonly string[]> = new Map(
  fieldSchema.options.map((schema) => {
    const keys = Object.keys(schema.shape);
    const type = [...(schema.shape.type as unknown as { values: Set<FieldType> }).values][0]!;
    return [type, keys];
  }),
);

/** The properties specific to `type`, in the order its schema declares them. */
export function specificProperties(type: FieldType): string[] {
  const common: readonly string[] = COMMON_PROPERTIES;
  return (SHAPES.get(type) ?? []).filter((property) => !common.includes(property));
}

/** Which editor a property gets, or `undefined` if the builder has none — which a test forbids. */
export function editorFor(type: FieldType, property: string): PropertyEditor | undefined {
  switch (property) {
    case 'minLength':
    case 'maxLength':
    case 'minSelected':
    case 'maxSelected':
    case 'minFiles':
    case 'maxFiles':
    case 'decimalPlaces':
    case 'scale':
      return 'integer';
    case 'unit':
      return 'text';
    case 'pattern':
      return 'pattern';
    case 'calculation':
      return 'calculation';
    case 'options':
      return 'options';
    case 'allowNotApplicable':
      return 'boolean';
    case 'maxFileBytes':
      return 'megabytes';
    case 'acceptedTypes':
      return 'media_types';
    case 'maxAccuracyMeters':
      return 'decimal';
    case 'earliest':
    case 'latest':
      return temporal(type);
    case 'min':
    case 'max':
      return type === 'number' ? 'integer' : type === 'decimal' ? 'decimal' : undefined;
    case 'default':
      return defaultEditor(type);
    default:
      return undefined;
  }
}

function temporal(type: FieldType): PropertyEditor | undefined {
  return type === 'date' || type === 'time' || type === 'datetime' ? type : undefined;
}

function defaultEditor(type: FieldType): PropertyEditor | undefined {
  switch (type) {
    case 'text':
    case 'long_text':
      return 'text';
    case 'number':
    case 'rating':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'date':
    case 'time':
    case 'datetime':
      return type;
    case 'dropdown':
    case 'radio':
      return 'choice';
    case 'multi_select':
      return 'choices';
    case 'checkbox':
      return 'boolean';
    case 'yes_no':
      return 'yes_no';
    default:
      return undefined;
  }
}
