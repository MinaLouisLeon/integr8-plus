import type { CompiledForm, ElementInfo, FieldType, LocalizedText } from '@integr8/form-engine';
import type { TemplateDesign } from './design.js';

/**
 * Which of a form's questions a PDF template names, and moving a template to
 * another form (form builder decision 10, 1.3.0).
 *
 * A template names questions by answer key — the field's id — in answer
 * blocks, check boxes and option lists, tables of fields, tables of a
 * repeating section's entries, pictures from a photo or signature answer,
 * document fields taken from an answer, and `{{answer.<key>}}` placeholders in
 * any text, the header's and footer's places included. It names one of the
 * form's Information blocks (form format 2) by its id in an `information`
 * block. Copying it to another form means finding each of those in the other
 * form, and either renaming it or taking out what used it.
 *
 * The walk is over the design as JSON rather than over its typed blocks, on
 * purpose: the design format grows (headers, styles, orientation), and a
 * reference anywhere — a placeholder in a new header slot included — must
 * still be found. What it knows of the format is only where references live:
 * a `fieldId`, a `sectionId`, a placeholder in a string; and what can be taken
 * out: a block, a row of a table of fields, a column of a section's table, a
 * document field.
 */

/** How a template uses a question, which decides what may stand in for it. */
export type ReferenceUse =
  /** Shown as an answer: a field block, a table row or column, a document field. */
  | 'answer'
  /** A `{{answer.<key>}}` placeholder in a text. */
  | 'placeholder'
  /** A picture block showing a photo or signature answer. */
  | 'image'
  /** Every option of a choice, yes/no or checkbox question, each with its box. */
  | 'options'
  /** One box, ticked on an option. */
  | 'checkbox'
  /** A table with a row per entry of a repeating section. */
  | 'section'
  /** One of the form's Information blocks, printed as the form shows it. */
  | 'information';

export interface DesignReference {
  /** A question's answer key, a repeating section's id, or an Information block's id. */
  id: string;
  kind: 'field' | 'section' | 'information';
  /** For a column of a repeating section's table: that section. */
  section?: string;
  uses: ReferenceUse[];
  /** The options check boxes tick on, for a choice question. */
  options: string[];
}

/** One reference, matched (or not) to a question of the target form. */
export interface ReferenceMatch {
  reference: DesignReference;
  /** The target's question, or null when nothing fits on its own. */
  match: string | null;
  /** How it was found: the same answer key, or the same wording. */
  by: 'key' | 'wording' | null;
  /** Every target question that could stand in for it, in form order. */
  candidates: string[];
}

/**
 * What to do with each reference when a template moves: the target's answer
 * key (or section) that takes its place, or `null` to take out what used it.
 */
export type ReferenceMapping = Readonly<Record<string, string | null>>;

/** A design as JSON: a value of any shape, walked without knowing its blocks. */
type Json = unknown;
type JsonObject = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*answer\.([a-z0-9_]+)\s*\}\}/gu;

/** Field types that show the same kind of answer, so one can stand in for another. */
const FAMILIES: readonly (readonly FieldType[])[] = [
  ['text', 'long_text', 'barcode'],
  ['number', 'decimal'],
  ['dropdown', 'radio'],
  ['photo', 'signature'],
];

const CHOICES: readonly string[] = ['dropdown', 'radio', 'multi_select'];
const OPTION_LISTS: readonly string[] = [...CHOICES, 'yes_no', 'checkbox'];
const YES_NO_OPTIONS: readonly string[] = ['yes', 'no', 'not_applicable'];

/** The keys that hold a reference's id. */
const REFERENCE_KEYS: ReadonlySet<string> = new Set(['fieldId', 'sectionId', 'informationId']);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every question and repeating section a design names, sections first. */
export function designReferences(design: TemplateDesign): DesignReference[] {
  const found = new Map<string, DesignReference>();
  const add = (
    id: string,
    kind: DesignReference['kind'],
    use: ReferenceUse,
    extra: { section?: string | undefined; option?: string | undefined } = {},
  ) => {
    const reference = found.get(id) ?? { id, kind, uses: [], options: [] };
    if (!reference.uses.includes(use)) {
      reference.uses.push(use);
    }
    if (extra.section !== undefined && reference.section === undefined) {
      reference.section = extra.section;
    }
    if (extra.option !== undefined && !reference.options.includes(extra.option)) {
      reference.options.push(extra.option);
    }
    found.set(id, reference);
  };

  const walk = (node: Json, block: JsonObject | undefined, key: string | undefined) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(PLACEHOLDER)) {
        add(match[1] ?? '', 'field', 'placeholder');
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, block, key);
      }
      return;
    }
    if (!isObject(node)) {
      return;
    }
    const isBlock = key === 'blocks' && typeof node.type === 'string';
    const current = isBlock ? node : block;
    if (isBlock && node.type === 'repeat_table' && typeof node.sectionId === 'string') {
      add(node.sectionId, 'section', 'section');
    }
    if (isBlock && node.type === 'information' && typeof node.informationId === 'string') {
      add(node.informationId, 'information', 'information');
    }
    if (typeof node.fieldId === 'string') {
      const type = current?.type;
      const section =
        type === 'repeat_table' && key === 'columns' && typeof current?.sectionId === 'string'
          ? current.sectionId
          : undefined;
      if (type === 'image' && key === 'source') {
        add(node.fieldId, 'field', 'image');
      } else if (type === 'options' && node === current) {
        add(node.fieldId, 'field', 'options');
      } else if (type === 'checkbox' && node === current) {
        add(node.fieldId, 'field', 'checkbox', {
          option: typeof node.option === 'string' ? node.option : undefined,
        });
      } else {
        add(node.fieldId, 'field', 'answer', { section });
      }
    }
    for (const [name, value] of Object.entries(node)) {
      if (!REFERENCE_KEYS.has(name)) {
        walk(value, current, name);
      }
    }
  };
  walk(design, undefined, undefined);

  return [...found.values()].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'section' ? -1 : 1,
  );
}

function familyOf(type: FieldType): readonly FieldType[] {
  return FAMILIES.find((family) => family.includes(type)) ?? [type];
}

/** Whether `target` may stand in for `reference` (whose question in its own form is `source`). */
function fits(
  reference: DesignReference,
  source: ElementInfo | undefined,
  target: ElementInfo,
  targetSection: string | null | undefined,
): boolean {
  if (reference.kind === 'section') {
    return target.kind === 'section' && target.repeat !== undefined;
  }
  if (reference.kind === 'information') {
    // An Information block prints only outside repeating sections.
    return target.kind === 'information' && target.entries === undefined;
  }
  const field = target.field;
  if (target.kind !== 'field' || field === undefined) {
    return false;
  }
  // A column of a section's table must be a question of the section the
  // table now shows; anything else must be outside every repeating section.
  if (reference.section === undefined) {
    if (target.entries !== undefined) {
      return false;
    }
  } else if (targetSection == null || target.entries !== targetSection) {
    return false;
  }
  if (source?.field !== undefined && !familyOf(source.field.type).includes(field.type)) {
    return false;
  }
  if (reference.uses.includes('image') && field.type !== 'photo' && field.type !== 'signature') {
    return false;
  }
  if (reference.uses.includes('options') && !OPTION_LISTS.includes(field.type)) {
    return false;
  }
  if (reference.uses.includes('checkbox')) {
    if (field.type === 'checkbox') {
      return true;
    }
    if (field.type === 'yes_no') {
      return reference.options.every((option) => YES_NO_OPTIONS.includes(option));
    }
    if (field.type === 'dropdown' || field.type === 'radio' || field.type === 'multi_select') {
      const values = new Set(field.options.map((option) => option.value));
      return (
        reference.options.length > 0 && reference.options.every((option) => values.has(option))
      );
    }
    return false;
  }
  return true;
}

/**
 * The target's questions (or repeating sections) that could stand in for a
 * reference, in the order a person reads the form. `targetSection` is where a
 * column's section went: a column can only move to a question of it.
 */
export function referenceCandidates(
  reference: DesignReference,
  source: CompiledForm | null,
  target: CompiledForm,
  targetSection?: string | null,
): string[] {
  const own = source?.elements.get(reference.id);
  return [...target.elements.values()]
    .filter((element) => fits(reference, own, element, targetSection))
    .sort((a, b) => a.index - b.index)
    .map((element) => element.id);
}

/**
 * What a question, section or Information block says, normalised for comparing
 * wordings: a question's label, a section's title, a block's heading (or, for
 * one without a heading, its paragraph).
 */
function wordingsOf(form: CompiledForm | null, id: string): string[] {
  if (form === null) {
    return [];
  }
  const element = form.elements.get(id);
  const information = element?.information;
  const text: LocalizedText | undefined =
    element?.field?.label ??
    (information === undefined ? undefined : (information.heading ?? information.body)) ??
    (element?.kind === 'section' ? sectionTitle(form, id) : undefined);
  return Object.values(text ?? {})
    .map((value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase())
    .filter((value) => value !== '');
}

function sectionTitle(form: CompiledForm, id: string): LocalizedText | undefined {
  for (const page of form.definition.pages) {
    for (const section of page.sections) {
      if (section.id === id) {
        return section.title;
      }
    }
  }
  return undefined;
}

/**
 * Matches every reference of a design to the target form: first the same
 * answer key where its question fits, then a question worded the same in
 * English or Arabic. What matches neither is left for a person to choose.
 */
export function matchDesignReferences(
  design: TemplateDesign,
  source: CompiledForm | null,
  target: CompiledForm,
): ReferenceMatch[] {
  const sections = new Map<string, string | null>();

  return designReferences(design).map((reference) => {
    const candidates = referenceCandidates(
      reference,
      source,
      target,
      reference.section === undefined ? undefined : (sections.get(reference.section) ?? null),
    );
    let match: string | null = null;
    let by: ReferenceMatch['by'] = null;
    if (candidates.includes(reference.id)) {
      match = reference.id;
      by = 'key';
    } else {
      const own = wordingsOf(source, reference.id);
      const same = candidates.find((candidate) =>
        wordingsOf(target, candidate).some((wording) => own.includes(wording)),
      );
      if (same !== undefined) {
        match = same;
        by = 'wording';
      }
    }
    if (reference.kind === 'section') {
      sections.set(reference.id, match);
    }
    return { reference, match, by, candidates };
  });
}

/**
 * The references a mapping leaves undecided. A column of a section's table
 * whose section is being taken out needs no decision: the table goes with it.
 */
export function unresolvedReferences(
  references: readonly DesignReference[],
  mapping: ReferenceMapping,
): DesignReference[] {
  return references.filter((reference) => {
    if (Object.hasOwn(mapping, reference.id)) {
      return false;
    }
    if (
      reference.section !== undefined &&
      Object.hasOwn(mapping, reference.section) &&
      mapping[reference.section] === null &&
      reference.uses.every((use) => use === 'answer')
    ) {
      return false;
    }
    return true;
  });
}

/** The mapping the automatic matches make, before anybody has chosen anything. */
export function automaticMapping(matches: readonly ReferenceMatch[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const entry of matches) {
    if (entry.match !== null) {
      mapping[entry.reference.id] = entry.match;
    }
  }
  return mapping;
}

/** Marks a node to be taken out by the nearest list it can be taken out of. */
const REMOVE = Symbol('remove');
/** A text all of whose languages were only placeholders now taken out. */
const EMPTIED = Symbol('emptied');
/** A header or footer place left with no text: the place becomes empty (`null`). */
const VACATED = Symbol('vacated');
type Rewritten = unknown;

/**
 * A copy of the design with every reference renamed as `mapping` says, and
 * whatever used a reference mapped to `null` taken out: the block, or the row
 * of a table of fields, the column of a section's table, the document field. A
 * table left with no rows or columns goes too. A placeholder outside anything
 * that can be taken out (a header or footer place, say) is removed from its
 * text instead; a language left with nothing goes, and a place left with no
 * language at all is emptied. References the mapping does not name are left as
 * they are.
 */
export function rewriteDesignReferences(
  design: TemplateDesign,
  mapping: ReferenceMapping,
): TemplateDesign {
  const rename = (id: string): string | null | undefined =>
    Object.hasOwn(mapping, id) ? mapping[id] : undefined;

  const text = (value: string, removable: boolean): Rewritten => {
    let gone = false;
    const replaced = value.replace(PLACEHOLDER, (whole, id: string) => {
      const next = rename(id);
      if (next === undefined) {
        return whole;
      }
      if (next === null) {
        gone = true;
        return '';
      }
      return `{{answer.${next}}}`;
    });
    return gone && removable ? REMOVE : replaced;
  };

  /** Whether the elements of the list under `key` can be taken out one by one. */
  const removableList = (key: string, items: Json[], depth: number): boolean =>
    key === 'blocks' ||
    (key === 'fields' && depth === 1) ||
    ((key === 'rows' || key === 'columns') &&
      items.every((item) => isObject(item) && typeof item.fieldId === 'string'));

  const walk = (node: Json, removable: boolean, depth: number): Rewritten => {
    if (typeof node === 'string') {
      return text(node, removable);
    }
    if (Array.isArray(node)) {
      const out: Json[] = [];
      for (const child of node) {
        const next = walk(child, removable, depth + 1);
        if (next === REMOVE) {
          return REMOVE;
        }
        // An emptied text in a list (a fixed table's cell) keeps its words, placeholder and all.
        out.push(next === EMPTIED || next === VACATED ? child : next);
      }
      return out;
    }
    if (!isObject(node)) {
      return node;
    }
    const out: JsonObject = {};
    let emptied = 0;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && !REFERENCE_KEYS.has(key)) {
        const next = text(value, removable);
        if (next === REMOVE) {
          return REMOVE;
        }
        if (next === '' && value !== '') {
          // A language that held only a placeholder now taken out.
          emptied += 1;
          continue;
        }
        out[key] = next;
        continue;
      }
      if (REFERENCE_KEYS.has(key) && typeof value === 'string') {
        const next = rename(value);
        if (next === null) {
          if (removable) {
            return REMOVE;
          }
          out[key] = value;
        } else {
          out[key] = next ?? value;
        }
        continue;
      }
      if (Array.isArray(value) && removableList(key, value, depth + 1)) {
        const kept: Json[] = [];
        for (const item of value) {
          const next = walk(item, true, depth + 2);
          if (next !== REMOVE) {
            kept.push(next);
          }
        }
        // A table that lost every row or column is taken out with them.
        if ((key === 'rows' || key === 'columns') && value.length > 0 && kept.length === 0) {
          if (removable) {
            return REMOVE;
          }
        }
        out[key] = kept;
        continue;
      }
      const next = walk(value, removable, depth + 1);
      if (next === REMOVE) {
        return REMOVE;
      }
      if (next === EMPTIED) {
        if (node.kind === 'text') {
          // A header or footer place: nothing left to print in it.
          return VACATED;
        }
        // Anywhere else nothing can be taken out: the text stays as it was.
        out[key] = value;
        continue;
      }
      out[key] = next === VACATED ? null : next;
    }
    if (emptied > 0 && Object.keys(out).length === 0) {
      return EMPTIED;
    }
    return out;
  };

  const result = walk(design, false, 0);
  const copy = (result === REMOVE ? design : result) as TemplateDesign;
  // The website's second lookup field needs the first; if the first went, so
  // does the second's role (the field itself stays).
  if (
    Array.isArray(copy.fields) &&
    copy.fields.some((field) => field.lookup === 'confirm') &&
    !copy.fields.some((field) => field.lookup === 'key')
  ) {
    copy.fields = copy.fields.map((field) =>
      field.lookup === 'confirm' ? { ...field, lookup: 'none' } : field,
    );
  }
  return copy;
}

/** Every uploaded file a design names, wherever it names one. */
export function referencedFileIds(design: TemplateDesign): string[] {
  const ids = new Set<string>();
  const walk = (node: Json) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isObject(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'fileId' && typeof value === 'string') {
        ids.add(value);
      } else {
        walk(value);
      }
    }
  };
  walk(design);
  return [...ids];
}

/**
 * A copy of the design naming other files: each picture copied to a new home
 * gets a new id. Files the map does not name are left as they are.
 */
export function replaceFileIds(
  design: TemplateDesign,
  replacements: ReadonlyMap<string, string>,
): TemplateDesign {
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isObject(node)) {
      return node;
    }
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === 'fileId' && typeof value === 'string'
          ? (replacements.get(value) ?? value)
          : walk(value);
    }
    return out;
  };
  return walk(design) as TemplateDesign;
}
