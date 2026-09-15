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
 *
 * ## Repeatable sections (P13b)
 *
 * A section with `repeat` asks its questions once per thing found on site —
 * every appliance, every radiator, every defect. Its answer is a list of
 * entries under the section's id, each with a stable id of its own and the
 * answers to the section's fields:
 *
 *   "appliances": [
 *     { "id": "0192f3a4-…", "values": { "make": "Worcester", "flue_ok": "yes" } }
 *   ]
 *
 * The fields of a repeatable section are never top-level answers. A rule inside
 * an entry reads that entry's answers and anything outside the section; a rule
 * outside reads the entries only through `count`, `aggregate`, `some` and
 * `every`. Sections do not nest, so neither do entries.
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
  /** The most entries a repeatable section may allow. */
  entriesPerSection: 100,
});

/**
 * An entry's id: chosen by whoever adds the entry (a UUID in every client), and
 * kept for the life of the submission, so an entry can be told apart from its
 * neighbours when one is removed, reordered or edited on another device.
 */
export const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const entryIdSchema = z.string().regex(ENTRY_ID, 'Not an entry id');

export const repeatSchema = z.strictObject({
  /** Fewer entries than this cannot be submitted. Absent means none are needed. */
  minEntries: z.number().int().min(0).max(LIMITS.entriesPerSection).optional(),
  maxEntries: z.number().int().min(1).max(LIMITS.entriesPerSection),
  /** What one entry is called: "Appliance", shown as "Appliance 1", "Appliance 2". */
  entryLabel: localizedTextSchema,
  /** A field of the section whose answer names each entry: "Appliance 2 · Worcester". */
  titleField: elementIdSchema.optional(),
});

export type Repeat = z.infer<typeof repeatSchema>;

export const sectionSchema = z.strictObject({
  id: elementIdSchema,
  title: localizedTextSchema.optional(),
  visibleWhen: expressionSchema.optional(),
  repeat: repeatSchema.optional(),
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

/** One entry of a repeatable section, as it is stored. */
export interface Entry {
  id: string;
  values: Record<string, unknown>;
}

export const entrySchema = z.strictObject({
  id: entryIdSchema,
  values: z.record(z.string(), z.unknown()),
});

/** The answer to a repeatable section: its entries, in the order the person put them. */
export const entriesSchema = z.array(entrySchema).max(LIMITS.entriesPerSection);
export type Page = z.infer<typeof pageSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
