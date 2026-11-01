import { z } from 'zod';
import { expressionSchema, VERSION_2_EXPRESSION_KINDS } from './expression.js';
import { sectionItemSchema } from './information.js';
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

/**
 * The newest definition format this engine reads. A definition says which it
 * needs in `schemaVersion`:
 *
 * - **1**: everything up to 1.2.x.
 * - **2** (1.3.0): a description under a page or section title, Information
 *   blocks among the questions, and calculations with dates and times, rounding,
 *   percentages, and the least, greatest or average of several answers.
 *
 * A definition declares the *lowest* version that has everything it uses
 * (`requiredSchemaVersion`), so a form that uses none of 2's additions stays a
 * version 1 form that every phone in the field can open. An engine meeting a
 * version newer than its own refuses it with `schema_version_unsupported`,
 * which an app shows as "update the app to open this form" — not as a broken
 * form. The API sets the version when a draft is saved, so nobody types it.
 */
export const DEFINITION_SCHEMA_VERSION = 2;

/** Every format this engine reads, oldest first. */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

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
  /** A line or two under the title (schema version 2). Plain text. */
  description: localizedTextSchema.optional(),
  visibleWhen: expressionSchema.optional(),
  repeat: repeatSchema.optional(),
  /**
   * The section's items in reading order: its questions and (schema version 2)
   * its Information blocks. The name is older than Information blocks; see
   * `information.ts` for why they share the list but not the type.
   */
  fields: z.array(sectionItemSchema).max(LIMITS.fieldsPerSection),
});

export const pageSchema = z.strictObject({
  id: elementIdSchema,
  title: localizedTextSchema.optional(),
  /** A line or two under the title (schema version 2). Plain text. */
  description: localizedTextSchema.optional(),
  visibleWhen: expressionSchema.optional(),
  sections: z.array(sectionSchema).min(1).max(LIMITS.sectionsPerPage),
});

export const formDefinitionSchema = z.strictObject({
  schemaVersion: z.union(SUPPORTED_SCHEMA_VERSIONS.map((version) => z.literal(version))),
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

// ---------------------------------------------------------------------------
// Which format a definition needs
// ---------------------------------------------------------------------------

const VERSION_2_KINDS: ReadonlySet<string> = VERSION_2_EXPRESSION_KINDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether any expression node anywhere under `value` is one version 2 added. */
function hasVersion2Node(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasVersion2Node);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.kind === 'string' && VERSION_2_KINDS.has(value.kind)) {
    return true;
  }
  return Object.values(value).some(hasVersion2Node);
}

/**
 * The lowest `schemaVersion` that has everything a definition uses.
 *
 * Read from the JSON as it is, valid or not, so a half-built draft is marked
 * as faithfully as a finished one; its own `schemaVersion` is not consulted.
 * The compiler refuses a definition that declares less than this, so a
 * published version always tells an older app, before it tries, that it cannot
 * open it.
 */
export function requiredSchemaVersion(definition: unknown): 1 | 2 {
  if (!isRecord(definition) || !Array.isArray(definition.pages)) {
    return 1;
  }
  for (const page of definition.pages as unknown[]) {
    if (!isRecord(page)) {
      continue;
    }
    if (page.description !== undefined || hasVersion2Node(page.visibleWhen)) {
      return 2;
    }
    for (const section of Array.isArray(page.sections) ? (page.sections as unknown[]) : []) {
      if (!isRecord(section)) {
        continue;
      }
      if (section.description !== undefined || hasVersion2Node(section.visibleWhen)) {
        return 2;
      }
      for (const item of Array.isArray(section.fields) ? (section.fields as unknown[]) : []) {
        if (!isRecord(item)) {
          continue;
        }
        if (
          item.type === 'information' ||
          (item.type === 'date' && item.calculation !== undefined) ||
          hasVersion2Node(item)
        ) {
          return 2;
        }
      }
    }
  }
  return 1;
}

/**
 * The same definition declaring the version it needs, for whoever stores one:
 * the API on every draft save, and the builder on every edit. Anything that is
 * not an object is returned untouched — the compiler says what is wrong with it.
 */
export function withRequiredSchemaVersion<T>(input: T): T {
  if (!isRecord(input)) {
    return input;
  }
  const needed = requiredSchemaVersion(input);
  return input.schemaVersion === needed ? input : { ...input, schemaVersion: needed };
}
