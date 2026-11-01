import { z } from 'zod';
import { formDefinitionSchema, type FormDefinition } from '../definition.js';
import { type LocalizedText, localizedTextSchema } from '../ids.js';

/**
 * Every text a form's admin wrote, wherever it sits in the definition.
 *
 * A form carries its own translations (see `localizedTextSchema`), so whether a
 * form "has Arabic" is a question about each of its texts: the title, every
 * page, section and question, every option, every custom rule's message, every
 * entry label. The builder's Translations tab lists them, and the publish check
 * warns about the ones with no Arabic. Both call this, so they always count the
 * same texts.
 *
 * **Found by the schema, not by a list.** The walk follows
 * `formDefinitionSchema` and stops at every use of `localizedTextSchema`, so a
 * text added to the format later (a section description, an information block)
 * is listed here the day it is added, without anybody remembering to. Rule
 * expressions are skipped: they hold no text.
 *
 * The walk reads drafts, which may not compile yet: it goes by shape and never
 * refuses a definition. A question whose type is unknown contributes the texts
 * every question has (its label, help and rule messages).
 */

/** Where a text is, and what it is. */
export interface TextLocation {
  /** From the definition's root: `['pages', 0, 'sections', 1, 'fields', 2, 'label']`. */
  readonly path: readonly (string | number)[];
  /** The same, as the compiler writes paths: `pages[0].sections[1].fields[2].label`. */
  readonly pathText: string;
  /** The page it is on, if it is not the form's own title. */
  readonly page: string | undefined;
  /** The section it is in, if it is inside one. */
  readonly section: string | undefined;
  /** The page, section or question the text belongs to; `undefined` for the form itself. */
  readonly element: string | undefined;
  readonly elementKind: 'form' | 'page' | 'section' | 'field';
  /**
   * What the text is to its element, without positions: `label`, `help`,
   * `title`, `options.label`, `rules.message`, `pattern.message`,
   * `repeat.entryLabel`.
   */
  readonly property: string;
  /** Which option or rule, for a text inside one: the option's value or the rule's id. */
  readonly detail: string | undefined;
  /** Whether the text may be removed altogether (help, a section's title), or must stay. */
  readonly optional: boolean;
  readonly text: Readonly<Record<string, string>>;
}

const ELEMENT_KINDS: Readonly<Record<string, TextLocation['elementKind']>> = {
  pages: 'page',
  sections: 'section',
  fields: 'field',
};

interface Owner {
  page: string | undefined;
  section: string | undefined;
  element: string | undefined;
  elementKind: TextLocation['elementKind'];
  /** Path of the element, so a text's property is named relative to it. */
  depth: number;
  /** The option or rule the walk is inside, if any. */
  detail: string | undefined;
}

/** Every text in the definition, in the order a person reads the form. */
export function collectTexts(
  definition: FormDefinition | Readonly<Record<string, unknown>>,
): TextLocation[] {
  const found: TextLocation[] = [];
  walk(formDefinitionSchema, definition, [], false, found, {
    page: undefined,
    section: undefined,
    element: undefined,
    elementKind: 'form',
    depth: 0,
    detail: undefined,
  });
  return found;
}

/** Whether a text has nothing in `locale`. */
export function lacksLanguage(text: Readonly<Record<string, string>>, locale: string): boolean {
  const value = text[locale];
  return value === undefined || value.trim() === '';
}

/** The texts that have nothing in `locale`: "12 texts have no Arabic". */
export function missingTranslations(
  definition: FormDefinition | Readonly<Record<string, unknown>>,
  locale: string,
): TextLocation[] {
  return collectTexts(definition).filter((location) => lacksLanguage(location.text, locale));
}

/**
 * One language of a text set, or removed when `value` is empty. Returns
 * `undefined` when no language is left, which the caller stores as "no text"
 * for an optional one.
 */
export function withLanguage(
  text: Readonly<Record<string, string>> | undefined,
  locale: string,
  value: string,
): LocalizedText | undefined {
  const next: Record<string, string> = { ...(text ?? {}) };
  if (value.trim() === '') {
    delete next[locale];
  } else {
    next[locale] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * The definition with the text at `path` replaced. `undefined` removes the
 * property, which is right for an optional text; for a required one the caller
 * passes what is left (possibly `{}`, which the compiler then names as a
 * problem, the same as clearing a label in the settings panel).
 */
export function setText(
  definition: FormDefinition,
  path: readonly (string | number)[],
  text: LocalizedText | undefined,
): FormDefinition {
  return setIn(definition, path, text) as FormDefinition;
}

function setIn(container: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  if (Array.isArray(container) && typeof head === 'number') {
    if (head < 0 || head >= container.length) {
      return container;
    }
    const next = [...(container as unknown[])];
    next[head] = setIn(next[head], rest, value);
    return next;
  }
  if (typeof container === 'object' && container !== null && typeof head === 'string') {
    const record = container as Record<string, unknown>;
    if (rest.length > 0 && !(head in record)) {
      return container;
    }
    const next = { ...record };
    const updated = rest.length === 0 ? value : setIn(record[head], rest, value);
    if (updated === undefined) {
      delete next[head];
    } else {
      next[head] = updated;
    }
    return next;
  }
  return container;
}

function walk(
  schema: z.core.$ZodType,
  value: unknown,
  path: (string | number)[],
  optional: boolean,
  found: TextLocation[],
  owner: Owner,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (schema === localizedTextSchema) {
    if (isTextRecord(value)) {
      found.push(locationOf(path, optional, owner, value));
    }
    return;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    walk(schema.unwrap(), value, path, true, found, owner);
    return;
  }
  if (schema instanceof z.ZodLazy) {
    // Rule expressions: no admin-written text inside.
    return;
  }
  if (schema instanceof z.ZodArray) {
    if (!Array.isArray(value)) {
      return;
    }
    const key = path.at(-1);
    const kind = typeof key === 'string' ? ELEMENT_KINDS[key] : undefined;
    value.forEach((item: unknown, index) => {
      const itemPath = [...path, index];
      const id = identity(item);
      const next: Owner =
        kind === undefined
          ? { ...owner, detail: id ?? String(index) }
          : {
              page: kind === 'page' ? id : owner.page,
              section: kind === 'section' ? id : kind === 'page' ? undefined : owner.section,
              element: id,
              elementKind: kind,
              depth: itemPath.length,
              detail: undefined,
            };
      walk(schema.element, item, itemPath, false, found, next);
    });
    return;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const discriminator = (schema.def as { discriminator: string }).discriminator;
    const tag = isRecord(value) ? value[discriminator] : undefined;
    const options = schema.options;
    const match = options.find(
      (option) =>
        option instanceof z.ZodObject &&
        literalMatches(option.shape[discriminator] as z.core.$ZodType | undefined, tag),
    );
    if (match !== undefined) {
      walk(match, value, path, optional, found, owner);
      return;
    }
    // A type this engine does not know: the keys every option shares still say what they hold.
    walkShared(options, value, path, found, owner);
    return;
  }
  if (schema instanceof z.ZodUnion) {
    walkShared(schema.options, value, path, found, owner);
    return;
  }
  if (schema instanceof z.ZodObject) {
    if (!isRecord(value)) {
      return;
    }
    const shape = schema.shape as Record<string, z.core.$ZodType>;
    // A question's own rules are read after its options: that is the order the panel shows them.
    const keys = Object.keys(shape).sort((a, b) => Number(a === 'rules') - Number(b === 'rules'));
    for (const key of keys) {
      const child = shape[key]!;
      if (key in value) {
        walk(child, value[key], [...path, key], false, found, owner);
      }
    }
    return;
  }
  if (schema instanceof z.ZodPipe) {
    walk(schema.in, value, path, optional, found, owner);
  }
}

/** For an unknown union member: walks the object keys whose schema every object option agrees on. */
function walkShared(
  options: readonly z.core.$ZodType[],
  value: unknown,
  path: (string | number)[],
  found: TextLocation[],
  owner: Owner,
): void {
  if (!isRecord(value)) {
    return;
  }
  const objects = options.filter((option) => option instanceof z.ZodObject);
  const first = objects[0];
  if (first === undefined) {
    return;
  }
  const shape: Record<string, z.core.$ZodType> = first.shape;
  for (const [key, child] of Object.entries(shape)) {
    const shared = objects.every(
      (option) => (option.shape as Record<string, unknown>)[key] === child,
    );
    if (shared && key in value) {
      walk(child, value[key], [...path, key], false, found, owner);
    }
  }
}

function literalMatches(schema: z.core.$ZodType | undefined, tag: unknown): boolean {
  if (!(schema instanceof z.ZodLiteral)) {
    return false;
  }
  return (schema.values as ReadonlySet<unknown>).has(tag);
}

function locationOf(
  path: readonly (string | number)[],
  optional: boolean,
  owner: Owner,
  text: Readonly<Record<string, string>>,
): TextLocation {
  const relative = path.slice(owner.depth).filter((segment) => typeof segment === 'string');
  return {
    path: [...path],
    pathText: formatPath(path),
    page: owner.page,
    section: owner.section,
    element: owner.element,
    elementKind: owner.elementKind,
    property: relative.join('.'),
    detail: owner.detail,
    optional,
    text,
  };
}

/** A page's, section's or question's id; an option's value. */
function identity(item: unknown): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  if (typeof item.id === 'string') {
    return item.id;
  }
  return typeof item.value === 'string' ? item.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function formatPath(path: readonly (string | number)[]): string {
  let text = '';
  for (const segment of path) {
    text +=
      typeof segment === 'number' ? `[${String(segment)}]` : `${text === '' ? '' : '.'}${segment}`;
  }
  return text;
}
