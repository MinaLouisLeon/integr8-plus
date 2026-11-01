import { z } from 'zod';
import { expressionSchema } from './expression.js';
import { type Field, fieldSchema } from './field-types.js';
import { elementIdSchema, localizedTextSchema } from './ids.js';

/**
 * Text that is not a question (schema version 2): an "Information" block among
 * a section's questions — "Isolate the supply before opening the casing" —
 * with an optional heading, a paragraph and a style.
 *
 * ## Why an item beside the questions, not a field type
 *
 * It is stored in the section's `fields` list, with `type: 'information'`, so
 * it sits exactly where the author put it between two questions, moves and
 * duplicates like one, shares their ids and follows "Shown when" the same way.
 * But in the engine's types it is *not* a `Field`: a `Field` is something a
 * person answers, and everything that lists answers — the compiled form's
 * `fields`, validation, submissions, reporting columns, exports, the
 * assistant's view of a submission, a PDF's answer blocks — reads `Field`s.
 * Keeping the two apart in the type system means an Information block cannot
 * reach any of those by accident: code that takes a section's items has to
 * say which it wants (`isQuestion`, `isInformation`), and the compiler finds
 * every place that has not.
 *
 * The paragraph is plain text. Line breaks are kept; nothing is read as HTML
 * or Markdown, on any platform.
 */

export const INFORMATION_STYLES = ['plain', 'tip', 'warning'] as const;
export type InformationStyle = (typeof INFORMATION_STYLES)[number];

export const informationSchema = z.strictObject({
  id: elementIdSchema,
  type: z.literal('information'),
  heading: localizedTextSchema.optional(),
  /** The paragraph. Plain text; line breaks are kept. */
  body: localizedTextSchema,
  /** How it stands out: `plain` (the default), a `tip`, or a `warning` in amber. */
  style: z.enum(INFORMATION_STYLES).optional(),
  visibleWhen: expressionSchema.optional(),
});

export type Information = z.infer<typeof informationSchema>;

/** One item of a section, in reading order: a question, or an Information block. */
export const sectionItemSchema = z.discriminatedUnion('type', [fieldSchema, informationSchema]);

export type SectionItem = Field | Information;

export function isInformation(item: SectionItem): item is Information {
  return item.type === 'information';
}

export function isQuestion(item: SectionItem): item is Field {
  return item.type !== 'information';
}

/** The questions among a list of items, in order. */
export function questionsOf(items: readonly SectionItem[]): Field[] {
  return items.filter(isQuestion);
}
