import { z } from 'zod';
import { expressionSchema } from './expression.js';
import { fieldSchema } from './field-types.js';
import { elementIdSchema, localizedTextSchema } from './ids.js';

/**
 * What a form *is*: pages of sections of fields.
 *
 * This is the document a company admin builds in P07, stored verbatim in
 * `form_versions.definition`, and read back — unchanged, forever — by every
 * submission bound to that version. Three consequences shape it:
 *
 * - **It is versioned by `schemaVersion`.** When the engine's own definition
 *   format changes, old versions are read by the old rules, not reinterpreted.
 * - **It is strict.** An unknown property is an error, not something silently
 *   dropped, because a property the engine ignores today is one somebody
 *   expected to do something.
 * - **It is bounded.** A definition is customer input evaluated on a phone and
 *   on a shared server, so the number of fields, the size of a rule and the
 *   depth of nesting all have ceilings.
 */

export const DEFINITION_SCHEMA_VERSION = 1;

/** Generous for a field form, small enough that evaluation is instant on a cheap phone. */
export const LIMITS = Object.freeze({
  pages: 50,
  sectionsPerPage: 100,
  fieldsPerSection: 200,
  fieldsTotal: 1_000,
  expressionNodes: 500,
  expressionDepth: 32,
});

export const sectionSchema = z.strictObject({
  id: elementIdSchema,
  title: localizedTextSchema.optional(),
  visibleWhen: expressionSchema.optional(),
  fields: z.array(fieldSchema).max(LIMITS.fieldsPerSection),
});

export const pageSchema = z.strictObject({
  id: elementIdSchema,
  title: localizedTextSchema.optional(),
  visibleWhen: expressionSchema.optional(),
  sections: z.array(sectionSchema).min(1).max(LIMITS.sectionsPerPage),
});

export const formDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(DEFINITION_SCHEMA_VERSION),
  title: localizedTextSchema,
  pages: z.array(pageSchema).min(1).max(LIMITS.pages),
});

export type Section = z.infer<typeof sectionSchema>;
export type Page = z.infer<typeof pageSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
