import { z } from 'zod';
import { compareCodeUnits } from './canonical.js';
import { compareDecimal, formatDecimal, fractionDigits, parseDecimal } from './decimal.js';
import { expressionSchema } from './expression.js';
import { type ElementId, elementIdSchema, localizedTextSchema } from './ids.js';
import { checkPattern, matchesPattern } from './pattern.js';
import { parseDate, parseDatetime, parseTime } from './temporal.js';

/**
 * The field type registry.
 *
 * Every field type is described once, here, by four things: the shape of its
 * definition, the shape of an answer to it, what kind of value it contributes
 * to a rule, and how an answer is validated. The builder (P07), both renderers
 * (P08, P13) and the API's revalidation all read this one table, which is what
 * keeps a field from meaning something slightly different in each of them.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A custom rule with the admin's own message. Fails when `assert` is definitely false. */
export const ruleSchema = z.strictObject({
  id: elementIdSchema,
  assert: expressionSchema,
  message: localizedTextSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const optionSchema = z.strictObject({
  /** Stored in answers. Stable, like a field id: relabelling keeps it. */
  value: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Use lowercase letters, digits, "_" or "-"'),
  label: localizedTextSchema,
});
export type Option = z.infer<typeof optionSchema>;

const decimalTextSchema = z.string().max(64);

/**
 * A reference to an uploaded file. The bytes live in R2 (P09); a submission
 * holds only this. Size and type travel with the reference so the engine can
 * enforce "photos under 10 MB" without a network call.
 */
export const mediaReferenceSchema = z.strictObject({
  mediaId: z.uuid(),
  contentType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, 'Not a media type'),
  byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type MediaReference = z.infer<typeof mediaReferenceSchema>;

export const geoPointSchema = z.strictObject({
  latitude: decimalTextSchema,
  longitude: decimalTextSchema,
  accuracyMeters: decimalTextSchema.optional(),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

const base = {
  id: elementIdSchema,
  label: localizedTextSchema,
  help: localizedTextSchema.optional(),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  visibleWhen: expressionSchema.optional(),
  /**
   * Mandatory only sometimes: "Reason" must be answered when "Result" is
   * "Fail". A field is required when `required` is true *or* this is
   * definitely true. Like `visibleWhen`, unknown counts as not required.
   */
  requiredWhen: expressionSchema.optional(),
  rules: z.array(ruleSchema).max(50).optional(),
};

const choices = z.array(optionSchema).min(1).max(1_000);

/**
 * Cascading lists: which of this field's options are offered depends on the
 * answer to another choice field — "Area" narrows "Room".
 *
 * `options` maps an option value of *this* field to the parent's values that
 * reveal it. An option absent from the map is offered whatever the parent's
 * answer. While the parent is unanswered nothing is offered at all, and the
 * renderer says which question to answer first. A multi-select parent reveals
 * the union of what each selected value reveals.
 */
export const dependsOnSchema = z.strictObject({
  field: elementIdSchema,
  options: z.record(z.string().max(64), z.array(z.string().max(64)).min(1).max(1_000)),
});
export type DependsOn = z.infer<typeof dependsOnSchema>;

const mediaTypes = z
  .array(
    z
      .string()
      .regex(/^[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*)$/, 'Use a media type like image/jpeg or image/*'),
  )
  .min(1)
  .max(50);

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export const fieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('text'),
    minLength: z.number().int().min(0).max(10_000).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    pattern: z
      .strictObject({
        source: z.string(),
        caseInsensitive: z.boolean().optional(),
        message: localizedTextSchema.optional(),
      })
      .optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('long_text'),
    minLength: z.number().int().min(0).max(100_000).optional(),
    maxLength: z.number().int().min(1).max(100_000).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('number'),
    unit: z.string().min(1).max(20).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    default: z.number().int().optional(),
    calculation: expressionSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('decimal'),
    decimalPlaces: z.number().int().min(0).max(6),
    unit: z.string().min(1).max(20).optional(),
    min: decimalTextSchema.optional(),
    max: decimalTextSchema.optional(),
    default: decimalTextSchema.optional(),
    calculation: expressionSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('date'),
    earliest: z.string().max(32).optional(),
    latest: z.string().max(32).optional(),
    default: z.string().max(32).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('time'),
    earliest: z.string().max(32).optional(),
    latest: z.string().max(32).optional(),
    default: z.string().max(32).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('datetime'),
    earliest: z.string().max(32).optional(),
    latest: z.string().max(32).optional(),
    default: z.string().max(32).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('dropdown'),
    options: choices,
    dependsOn: dependsOnSchema.optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('radio'),
    options: choices,
    dependsOn: dependsOnSchema.optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('multi_select'),
    options: choices,
    dependsOn: dependsOnSchema.optional(),
    minSelected: z.number().int().min(0).max(1_000).optional(),
    maxSelected: z.number().int().min(1).max(1_000).optional(),
    default: z.array(z.string()).max(1_000).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('checkbox'),
    default: z.boolean().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('yes_no'),
    allowNotApplicable: z.boolean().optional(),
    default: z.enum(['yes', 'no', 'not_applicable']).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('rating'),
    scale: z.number().int().min(3).max(10),
    default: z.number().int().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('signature'),
  }),
  z.strictObject({
    ...base,
    type: z.literal('photo'),
    minFiles: z.number().int().min(0).max(50).optional(),
    maxFiles: z.number().int().min(1).max(50).optional(),
    maxFileBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('file'),
    minFiles: z.number().int().min(0).max(50).optional(),
    maxFiles: z.number().int().min(1).max(50).optional(),
    maxFileBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    acceptedTypes: mediaTypes.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('gps'),
    maxAccuracyMeters: decimalTextSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('barcode'),
    maxLength: z.number().int().min(1).max(1_000).optional(),
  }),
]);

export type Field = z.infer<typeof fieldSchema>;
export type FieldType = Field['type'];
export type FieldOf<T extends FieldType> = Extract<Field, { type: T }>;

/** A field whose options can depend on another field's answer. */
export type DependentChoiceField = FieldOf<'dropdown' | 'radio' | 'multi_select'>;

/** How a field's options depend on another answer, or `undefined` when they do not. */
export function dependsOnOf(field: Field): DependsOn | undefined {
  return field.type === 'dropdown' || field.type === 'radio' || field.type === 'multi_select'
    ? field.dependsOn
    : undefined;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * What a field contributes to a rule.
 *
 * `options` is a multi-select answer, testable only with `includes`. `opaque`
 * is a photo, a file, a signature or a location: a rule may ask whether it was
 * given, and nothing else — "show this when the photo is…" has no sensible end.
 */
export type ValueType =
  'text' | 'number' | 'boolean' | 'date' | 'time' | 'datetime' | 'options' | 'opaque';

/** Grouped by what a person is trying to capture, for the builder's palette. */
export type FieldPurpose =
  'writing' | 'measuring' | 'scheduling' | 'choosing' | 'evidence' | 'location';

export interface FieldTypeDescription {
  type: FieldType;
  purpose: FieldPurpose;
  valueType: ValueType;
  /** Whether the value can be produced by a `calculation` instead of typed. */
  calculable: boolean;
}

export const FIELD_TYPES: readonly FieldTypeDescription[] = Object.freeze([
  { type: 'text', purpose: 'writing', valueType: 'text', calculable: false },
  { type: 'long_text', purpose: 'writing', valueType: 'text', calculable: false },
  { type: 'barcode', purpose: 'writing', valueType: 'text', calculable: false },
  { type: 'number', purpose: 'measuring', valueType: 'number', calculable: true },
  { type: 'decimal', purpose: 'measuring', valueType: 'number', calculable: true },
  { type: 'rating', purpose: 'measuring', valueType: 'number', calculable: false },
  { type: 'date', purpose: 'scheduling', valueType: 'date', calculable: false },
  { type: 'time', purpose: 'scheduling', valueType: 'time', calculable: false },
  { type: 'datetime', purpose: 'scheduling', valueType: 'datetime', calculable: false },
  { type: 'dropdown', purpose: 'choosing', valueType: 'text', calculable: false },
  { type: 'radio', purpose: 'choosing', valueType: 'text', calculable: false },
  { type: 'multi_select', purpose: 'choosing', valueType: 'options', calculable: false },
  { type: 'checkbox', purpose: 'choosing', valueType: 'boolean', calculable: false },
  { type: 'yes_no', purpose: 'choosing', valueType: 'text', calculable: false },
  { type: 'signature', purpose: 'evidence', valueType: 'opaque', calculable: false },
  { type: 'photo', purpose: 'evidence', valueType: 'opaque', calculable: false },
  { type: 'file', purpose: 'evidence', valueType: 'opaque', calculable: false },
  { type: 'gps', purpose: 'location', valueType: 'opaque', calculable: false },
] satisfies FieldTypeDescription[]);

const DESCRIPTIONS = new Map(FIELD_TYPES.map((description) => [description.type, description]));

export function describeFieldType(type: FieldType): FieldTypeDescription {
  const description = DESCRIPTIONS.get(type);
  /* v8 ignore next 3 -- the registry is exhaustive; the type system guarantees the lookup */
  if (description === undefined) {
    throw new Error(`Unknown field type "${type}"`);
  }
  return description;
}

/** The option values a choice field offers, or `undefined` for any other field. */
export function choiceValues(field: Field): readonly string[] | undefined {
  switch (field.type) {
    case 'dropdown':
    case 'radio':
    case 'multi_select':
      return field.options.map((option) => option.value);
    case 'yes_no':
      return field.allowNotApplicable === true ? ['yes', 'no', 'not_applicable'] : ['yes', 'no'];
    default:
      return undefined;
  }
}

export function isCalculated(field: Field): boolean {
  return (field.type === 'number' || field.type === 'decimal') && field.calculation !== undefined;
}

// ---------------------------------------------------------------------------
// Answers: shape
// ---------------------------------------------------------------------------

/**
 * The shape an answer to this field must have — before any rule about it.
 *
 * Shape and rules are kept apart on purpose. A photo answer that is not an array
 * is malformed data and is refused outright; a photo answer with too many
 * photos is a well-formed answer that breaks a rule, which a person needs to be
 * told about field by field.
 */
export function answerSchemaFor(field: Field): z.ZodType {
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'barcode':
    case 'decimal':
    case 'date':
    case 'time':
    case 'datetime':
    case 'dropdown':
    case 'radio':
      return z.string();
    case 'number':
    case 'rating':
      return z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
    case 'multi_select':
      return z.array(z.string()).max(1_000);
    case 'checkbox':
      return z.boolean();
    case 'yes_no':
      return z.enum(['yes', 'no', 'not_applicable']);
    case 'signature':
      return mediaReferenceSchema;
    case 'photo':
    case 'file':
      return z.array(mediaReferenceSchema).max(50);
    case 'gps':
      return geoPointSchema;
  }
}

export function hasAnswerShape(field: Field, value: unknown): boolean {
  return answerSchemaFor(field).safeParse(value).success;
}

/**
 * Whether a well-formed value counts as an answer.
 *
 * An empty string, an empty selection and an empty photo list are not answers.
 * An unticked checkbox is — `false` is a statement — but it does not satisfy
 * `required`, which on a checkbox means "must be ticked"; see `validateAnswer`.
 */
export function isAnswered(field: Field, value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'barcode':
    case 'decimal':
    case 'date':
    case 'time':
    case 'datetime':
    case 'dropdown':
    case 'radio':
      return value !== '';
    case 'multi_select':
    case 'photo':
    case 'file':
      return Array.isArray(value) && value.length > 0;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Answers: rules
// ---------------------------------------------------------------------------

export const FIELD_ERROR_CODES = [
  'required',
  'invalid',
  'too_short',
  'too_long',
  'pattern_mismatch',
  'below_minimum',
  'above_maximum',
  'too_many_decimal_places',
  'before_earliest',
  'after_latest',
  'unknown_option',
  // A choice this field offers, but not for the current answer to the field it depends on.
  'option_unavailable',
  'duplicate_option',
  'too_few_selected',
  'too_many_selected',
  'too_few_files',
  'too_many_files',
  'file_too_large',
  'file_type_not_accepted',
  'out_of_range',
  'accuracy_too_low',
  'rule_failed',
  // A repeatable section (P13b), on the section itself.
  'too_few_entries',
  'too_many_entries',
] as const;

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

/**
 * One problem with one answer.
 *
 * `code` is the contract, and maps to a translated message in each app —
 * `form.errors.below_minimum` is "Must be at least {{minimum}}". `params` are
 * always strings, so the message can interpolate them and so the result is
 * canonical: a minimum of `2.50` is `"2.50"` everywhere, never `2.5` in one
 * engine and `2.50` in another.
 */
export interface FieldError {
  field: ElementId;
  code: FieldErrorCode;
  params: Readonly<Record<string, string>>;
  /** For a field of a repeatable section: the entry whose answer it is. */
  entry?: string;
}

type Emit = (code: FieldErrorCode, params?: Record<string, string>) => void;

/**
 * Every rule-level problem with a well-formed, answered value, in a fixed order.
 *
 * Does not evaluate custom rules (they need the whole form) and does not check
 * `required` (it needs to know the field is visible). Both happen in
 * `validation.ts`.
 */
export function validateAnswer(field: Field, value: unknown): FieldError[] {
  const errors: FieldError[] = [];
  const emit: Emit = (code, params = {}) => {
    errors.push({ field: field.id, code, params });
  };

  if (!hasAnswerShape(field, value)) {
    emit('invalid');
    return errors;
  }

  switch (field.type) {
    case 'text':
      checkLength(value as string, field.minLength, field.maxLength, emit);
      if (
        field.pattern !== undefined &&
        !matchesPattern(
          field.pattern.source,
          field.pattern.caseInsensitive === true,
          value as string,
        )
      ) {
        emit('pattern_mismatch');
      }
      break;
    case 'long_text':
      checkLength(value as string, field.minLength, field.maxLength, emit);
      break;
    case 'barcode':
      checkLength(value as string, undefined, field.maxLength ?? 1_000, emit);
      break;
    case 'number':
      if (field.min !== undefined && (value as number) < field.min) {
        emit('below_minimum', { minimum: String(field.min) });
      }
      if (field.max !== undefined && (value as number) > field.max) {
        emit('above_maximum', { maximum: String(field.max) });
      }
      break;
    case 'decimal':
      checkDecimal(field, value as string, emit);
      break;
    case 'date':
      checkOrdered(value as string, parseDate, field.earliest, field.latest, emit);
      break;
    case 'time':
      checkOrdered(value as string, parseTime, field.earliest, field.latest, emit);
      break;
    case 'datetime':
      checkOrdered(value as string, parseDatetime, field.earliest, field.latest, emit);
      break;
    case 'dropdown':
    case 'radio':
    case 'yes_no':
      if (!(choiceValues(field) ?? []).includes(value as string)) {
        emit('unknown_option');
      }
      break;
    case 'multi_select':
      checkSelection(field, value as string[], emit);
      break;
    case 'rating':
      if ((value as number) < 1 || (value as number) > field.scale) {
        emit('out_of_range', { minimum: '1', maximum: String(field.scale) });
      }
      break;
    case 'photo':
    case 'file':
      checkFiles(field, value as MediaReference[], emit);
      break;
    case 'gps':
      checkGeoPoint(field, value as GeoPoint, emit);
      break;
    case 'checkbox':
    case 'signature':
      break;
  }

  return errors;
}

function checkLength(
  value: string,
  min: number | undefined,
  max: number | undefined,
  emit: Emit,
): void {
  // Code points, not UTF-16 units, so an emoji outside the Basic Multilingual
  // Plane counts once rather than twice. Not grapheme clusters: 👍🏽 is still two,
  // and so is a letter with a separate combining mark. Counting what a person sees
  // needs Intl.Segmenter, which some Hermes builds lack, and a length that
  // disagreed between phone and server is the one outcome this package exists to
  // rule out.
  const length = [...value].length;
  if (min !== undefined && length < min) {
    emit('too_short', { minimum: String(min) });
  }
  if (max !== undefined && length > max) {
    emit('too_long', { maximum: String(max) });
  }
}

function checkDecimal(field: FieldOf<'decimal'>, value: string, emit: Emit): void {
  const parsed = parseDecimal(value);
  if (parsed === undefined) {
    emit('invalid');
    return;
  }
  if (fractionDigits(value) > field.decimalPlaces) {
    emit('too_many_decimal_places', { maximum: String(field.decimalPlaces) });
  }

  const min = field.min === undefined ? undefined : parseDecimal(field.min);
  const max = field.max === undefined ? undefined : parseDecimal(field.max);
  if (min !== undefined && compareDecimal(parsed, min) < 0) {
    emit('below_minimum', { minimum: formatDecimal(min) });
  }
  if (max !== undefined && compareDecimal(parsed, max) > 0) {
    emit('above_maximum', { maximum: formatDecimal(max) });
  }
}

function checkOrdered(
  value: string,
  parse: (text: string) => number | undefined,
  earliestText: string | undefined,
  latestText: string | undefined,
  emit: Emit,
): void {
  const parsed = parse(value);
  if (parsed === undefined) {
    emit('invalid');
    return;
  }

  const earliest = earliestText === undefined ? undefined : parse(earliestText);
  const latest = latestText === undefined ? undefined : parse(latestText);
  if (earliest !== undefined && earliestText !== undefined && parsed < earliest) {
    emit('before_earliest', { earliest: earliestText });
  }
  if (latest !== undefined && latestText !== undefined && parsed > latest) {
    emit('after_latest', { latest: latestText });
  }
}

function checkSelection(field: FieldOf<'multi_select'>, value: string[], emit: Emit): void {
  const offered = new Set(field.options.map((option) => option.value));
  if (value.some((selected) => !offered.has(selected))) {
    emit('unknown_option');
  }
  if (new Set(value).size !== value.length) {
    emit('duplicate_option');
  }
  if (field.minSelected !== undefined && value.length < field.minSelected) {
    emit('too_few_selected', { minimum: String(field.minSelected) });
  }
  if (field.maxSelected !== undefined && value.length > field.maxSelected) {
    emit('too_many_selected', { maximum: String(field.maxSelected) });
  }
}

function checkFiles(
  field: FieldOf<'photo'> | FieldOf<'file'>,
  value: MediaReference[],
  emit: Emit,
): void {
  if (field.minFiles !== undefined && value.length < field.minFiles) {
    emit('too_few_files', { minimum: String(field.minFiles) });
  }
  if (field.maxFiles !== undefined && value.length > field.maxFiles) {
    emit('too_many_files', { maximum: String(field.maxFiles) });
  }
  if (
    field.maxFileBytes !== undefined &&
    value.some((file) => file.byteSize > field.maxFileBytes!)
  ) {
    emit('file_too_large', { maximum: String(field.maxFileBytes) });
  }

  const accepted = field.type === 'photo' ? ['image/*'] : field.acceptedTypes;
  if (accepted !== undefined && value.some((file) => !accepts(accepted, file.contentType))) {
    emit('file_type_not_accepted');
  }
}

function accepts(accepted: readonly string[], contentType: string): boolean {
  return accepted.some((pattern) =>
    pattern.endsWith('/*') ? contentType.startsWith(pattern.slice(0, -1)) : pattern === contentType,
  );
}

function checkGeoPoint(field: FieldOf<'gps'>, value: GeoPoint, emit: Emit): void {
  const latitude = parseDecimal(value.latitude);
  const longitude = parseDecimal(value.longitude);
  const accuracy =
    value.accuracyMeters === undefined ? undefined : parseDecimal(value.accuracyMeters);

  if (
    latitude === undefined ||
    longitude === undefined ||
    (value.accuracyMeters !== undefined && accuracy === undefined) ||
    compareDecimal(latitude, { units: BigInt(-90), scale: 0 }) < 0 ||
    compareDecimal(latitude, { units: BigInt(90), scale: 0 }) > 0 ||
    compareDecimal(longitude, { units: BigInt(-180), scale: 0 }) < 0 ||
    compareDecimal(longitude, { units: BigInt(180), scale: 0 }) > 0
  ) {
    emit('invalid');
    return;
  }

  if (field.maxAccuracyMeters !== undefined) {
    const limit = parseDecimal(field.maxAccuracyMeters);
    // A reading with no stated accuracy cannot be shown to meet a limit.
    if (limit !== undefined && (accuracy === undefined || compareDecimal(accuracy, limit) > 0)) {
      emit('accuracy_too_low', { maximum: formatDecimal(limit) });
    }
  }
}

// ---------------------------------------------------------------------------
// Definitions: problems a well-shaped field definition can still have
// ---------------------------------------------------------------------------

export interface FieldConfigIssue {
  field: ElementId;
  property: string;
  message: string;
}

/**
 * Things zod cannot express about one field on its own: a minimum above its
 * maximum, a default that its own rules reject, a pattern that could hang the
 * server. Checked when a form is published.
 */
export function fieldConfigIssues(field: Field): FieldConfigIssue[] {
  const issues: FieldConfigIssue[] = [];
  const report = (property: string, message: string) => {
    issues.push({ field: field.id, property, message });
  };

  switch (field.type) {
    case 'text':
    case 'long_text':
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        report(
          'minLength',
          `minLength ${String(field.minLength)} is above maxLength ${String(field.maxLength)}`,
        );
      }
      if (field.type === 'text' && field.pattern !== undefined) {
        const check = checkPattern(field.pattern.source);
        if (!check.ok) {
          report(
            'pattern',
            `The pattern is not allowed: ${check.reason} (at character ${String(check.index + 1)})`,
          );
        }
      }
      break;
    case 'number':
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        report('min', `min ${String(field.min)} is above max ${String(field.max)}`);
      }
      break;
    case 'decimal':
      checkDecimalBounds(field, report);
      break;
    case 'date':
    case 'time':
    case 'datetime':
      checkTemporalBounds(field, report);
      break;
    case 'dropdown':
    case 'radio':
    case 'multi_select':
      checkOptions(field, report);
      break;
    case 'photo':
    case 'file':
      if (
        field.minFiles !== undefined &&
        field.maxFiles !== undefined &&
        field.minFiles > field.maxFiles
      ) {
        report(
          'minFiles',
          `minFiles ${String(field.minFiles)} is above maxFiles ${String(field.maxFiles)}`,
        );
      }
      break;
    case 'gps':
      if (field.maxAccuracyMeters !== undefined) {
        const limit = parseDecimal(field.maxAccuracyMeters);
        if (limit === undefined || limit.units <= BigInt(0)) {
          report('maxAccuracyMeters', 'maxAccuracyMeters must be a positive decimal number');
        }
      }
      break;
    default:
      break;
  }

  const defaultValue = 'default' in field ? field.default : undefined;

  if (isCalculated(field)) {
    if (field.required === true) {
      report('required', 'A calculated field is never typed, so it cannot be required');
    }
    if (field.requiredWhen !== undefined) {
      report('requiredWhen', 'A calculated field is never typed, so it cannot be required');
    }
    if (defaultValue !== undefined) {
      report('default', 'A calculated field cannot also have a default');
    }
  }

  if (defaultValue !== undefined && issues.length === 0) {
    const problems = validateAnswer(field, defaultValue);
    if (problems.length > 0) {
      report(
        'default',
        `The default breaks the field's own rules (${problems.map((problem) => problem.code).join(', ')})`,
      );
    }
  }

  const ruleIds = (field.rules ?? []).map((rule) => rule.id);
  const duplicateRule = ruleIds.find((id, index) => ruleIds.indexOf(id) !== index);
  if (duplicateRule !== undefined) {
    report('rules', `Two rules share the id "${duplicateRule}"`);
  }

  return issues;
}

function checkDecimalBounds(
  field: FieldOf<'decimal'>,
  report: (property: string, message: string) => void,
): void {
  const bound = (property: 'min' | 'max') => {
    const text = field[property];
    if (text === undefined) {
      return undefined;
    }
    const parsed = parseDecimal(text);
    if (parsed === undefined) {
      report(property, `${property} "${text}" is not a decimal number`);
      return undefined;
    }
    if (fractionDigits(text) > field.decimalPlaces) {
      report(property, `${property} "${text}" has more decimal places than the field allows`);
    }
    return parsed;
  };

  const min = bound('min');
  const max = bound('max');
  if (min !== undefined && max !== undefined && compareDecimal(min, max) > 0) {
    report('min', `min ${field.min ?? ''} is above max ${field.max ?? ''}`);
  }
}

function checkTemporalBounds(
  field: FieldOf<'date'> | FieldOf<'time'> | FieldOf<'datetime'>,
  report: (property: string, message: string) => void,
): void {
  const parse =
    field.type === 'date' ? parseDate : field.type === 'time' ? parseTime : parseDatetime;
  const bound = (property: 'earliest' | 'latest') => {
    const text = field[property];
    if (text === undefined) {
      return undefined;
    }
    const parsed = parse(text);
    if (parsed === undefined) {
      report(property, `${property} "${text}" is not a valid ${field.type}`);
    }
    return parsed;
  };

  const earliest = bound('earliest');
  const latest = bound('latest');
  if (earliest !== undefined && latest !== undefined && earliest > latest) {
    report('earliest', `earliest ${field.earliest ?? ''} is after latest ${field.latest ?? ''}`);
  }
}

function checkOptions(
  field: FieldOf<'dropdown'> | FieldOf<'radio'> | FieldOf<'multi_select'>,
  report: (property: string, message: string) => void,
): void {
  const values = field.options.map((option) => option.value);
  const duplicate = [...values]
    .sort(compareCodeUnits)
    .find((value, index, sorted) => sorted[index + 1] === value);
  if (duplicate !== undefined) {
    report('options', `Two options share the value "${duplicate}"`);
  }

  if (
    field.type === 'multi_select' &&
    field.minSelected !== undefined &&
    field.maxSelected !== undefined &&
    field.minSelected > field.maxSelected
  ) {
    report(
      'minSelected',
      `minSelected ${String(field.minSelected)} is above maxSelected ${String(field.maxSelected)}`,
    );
  }

  // Whether the parent and its values exist is the compiler's to check; that
  // the map names this field's own options is known here.
  if (field.dependsOn !== undefined) {
    const stray = Object.keys(field.dependsOn.options).find((value) => !values.includes(value));
    if (stray !== undefined) {
      report(
        `dependsOn.options.${stray}`,
        `dependsOn offers "${stray}" for some answers, but the field has no such option`,
      );
    }
  }
}
