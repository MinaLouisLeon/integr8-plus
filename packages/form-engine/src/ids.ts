import { z } from 'zod';

/**
 * Identifiers inside a form definition.
 *
 * A field id is the key an answer is stored under, in every submission, for
 * the life of the product. So it is **stable**: assigned by the builder when the
 * field is created, never derived from the label, never reused after the field
 * is deleted. Renaming "Serial no." to "Serial number" changes a label and
 * nothing else; version 1's submissions still line up with version 9's.
 *
 * Pages, sections and fields share one namespace, so an error message can name
 * "`site_access`" without saying which kind of thing it is, and a rule cannot
 * be ambiguous about what it points at.
 *
 * Lowercase ASCII, digits and underscores, starting with a letter. That keeps
 * an id usable as a JSON key, a Postgres generated-column name in P08, and a
 * CSV header, without escaping in any of them.
 */
export const ELEMENT_ID = /^[a-z][a-z0-9_]{0,63}$/;

export const elementIdSchema = z
  .string()
  .regex(ELEMENT_ID, 'Use 1–64 lowercase letters, digits or underscores, starting with a letter');

export type ElementId = z.infer<typeof elementIdSchema>;

/** Locale tags a label may be written in: `en`, `ar`, `en-GB`. */
export const localeTagSchema = z
  .string()
  .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, 'Use a tag like "en" or "ar"');

/**
 * Text a company admin wrote, in one or more languages.
 *
 * Definitions carry their own translations rather than keys into the product's
 * catalogue: the product translates its own interface, but it cannot translate
 * "Is the isolation valve tagged out?" for a customer. At least one language is
 * required; which one is the company's business.
 */
export const localizedTextSchema = z
  .record(localeTagSchema, z.string().min(1).max(2_000))
  .refine((value) => Object.keys(value).length > 0, 'Provide the text in at least one language');

export type LocalizedText = z.infer<typeof localizedTextSchema>;
