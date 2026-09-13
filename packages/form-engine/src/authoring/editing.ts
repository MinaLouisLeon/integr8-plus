import type { FormDefinition, Page, Section } from '../definition.js';
import { type Expression, referencedFields } from '../expression.js';
import type { Field } from '../field-types.js';
import type { ElementId } from '../ids.js';
import { generateId } from './scaffold.js';

/**
 * Edits to a definition, as pure functions.
 *
 * Every operation takes a definition and returns a new one; nothing is mutated,
 * so the builder's undo is "keep the previous value" and a test can assert on
 * any intermediate state. Operations that cannot apply — moving a field into a
 * section that does not exist, deleting the last page — return an `EditError`
 * rather than throwing, so the canvas can refuse a drop without a try block.
 *
 * None of these checks whether the result *compiles*. A half-built form is
 * allowed to be invalid; that is what a draft is. `compileDefinition` is run
 * on every change to show the admin what is wrong, and again at publish to
 * refuse it.
 */

export type EditError =
  | { error: 'not_found'; id: ElementId }
  | { error: 'last_page' }
  | { error: 'last_section'; page: ElementId }
  | { error: 'invalid_target'; id: ElementId };

export type EditResult = FormDefinition | EditError;

/** Narrows any edit's result — a definition, a duplicate, or an error. */
export function isEditError<T extends object>(result: T | EditError): result is EditError {
  return 'error' in result;
}

/** Every id in the definition, pages, sections and fields alike. */
export function allIds(definition: FormDefinition): ElementId[] {
  return definition.pages.flatMap((page) => [
    page.id,
    ...page.sections.flatMap((section) => [section.id, ...section.fields.map((field) => field.id)]),
  ]);
}

export interface Located {
  kind: 'page' | 'section' | 'field';
  page: number;
  section: number | undefined;
  field: number | undefined;
}

export function locate(definition: FormDefinition, id: ElementId): Located | undefined {
  for (const [pageIndex, page] of definition.pages.entries()) {
    if (page.id === id) {
      return { kind: 'page', page: pageIndex, section: undefined, field: undefined };
    }
    for (const [sectionIndex, section] of page.sections.entries()) {
      if (section.id === id) {
        return { kind: 'section', page: pageIndex, section: sectionIndex, field: undefined };
      }
      const fieldIndex = section.fields.findIndex((field) => field.id === id);
      if (fieldIndex !== -1) {
        return { kind: 'field', page: pageIndex, section: sectionIndex, field: fieldIndex };
      }
    }
  }
  return undefined;
}

export function findField(definition: FormDefinition, id: ElementId): Field | undefined {
  for (const page of definition.pages) {
    for (const section of page.sections) {
      const field = section.fields.find((candidate) => candidate.id === id);
      if (field !== undefined) {
        return field;
      }
    }
  }
  return undefined;
}

/** Every field in reading order. */
export function fieldsOf(definition: FormDefinition): Field[] {
  return definition.pages.flatMap((page) => page.sections.flatMap((section) => section.fields));
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

const clampIndex = (index: number | undefined, length: number) =>
  index === undefined ? length : Math.max(0, Math.min(index, length));

const insertAt = <T>(items: readonly T[], item: T, index: number | undefined): T[] => {
  const copy = [...items];
  copy.splice(clampIndex(index, copy.length), 0, item);
  return copy;
};

function mapPages(definition: FormDefinition, map: (page: Page) => Page): FormDefinition {
  return { ...definition, pages: definition.pages.map(map) };
}

function mapSections(
  definition: FormDefinition,
  map: (section: Section) => Section,
): FormDefinition {
  return mapPages(definition, (page) => ({ ...page, sections: page.sections.map(map) }));
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

export function addField(
  definition: FormDefinition,
  sectionId: ElementId,
  field: Field,
  index?: number,
): EditResult {
  if (locate(definition, sectionId)?.kind !== 'section') {
    return { error: 'not_found', id: sectionId };
  }
  return mapSections(definition, (section) =>
    section.id === sectionId
      ? { ...section, fields: insertAt(section.fields, field, index) }
      : section,
  );
}

export function addSection(
  definition: FormDefinition,
  pageId: ElementId,
  section: Section,
  index?: number,
): EditResult {
  if (locate(definition, pageId)?.kind !== 'page') {
    return { error: 'not_found', id: pageId };
  }
  return mapPages(definition, (page) =>
    page.id === pageId ? { ...page, sections: insertAt(page.sections, section, index) } : page,
  );
}

export function addPage(definition: FormDefinition, page: Page, index?: number): FormDefinition {
  return { ...definition, pages: insertAt(definition.pages, page, index) };
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

/**
 * Replaces a field with `update(field)`.
 *
 * The id is carried over whatever `update` returns. An id is the key every
 * submission stores its answer under; there is no edit that changes it.
 */
export function updateField(
  definition: FormDefinition,
  id: ElementId,
  update: (field: Field) => Field,
): EditResult {
  if (locate(definition, id)?.kind !== 'field') {
    return { error: 'not_found', id };
  }
  return mapSections(definition, (section) => ({
    ...section,
    fields: section.fields.map((field) => (field.id === id ? { ...update(field), id } : field)),
  }));
}

export function updateSection(
  definition: FormDefinition,
  id: ElementId,
  update: (section: Omit<Section, 'fields'>) => Omit<Section, 'fields'>,
): EditResult {
  if (locate(definition, id)?.kind !== 'section') {
    return { error: 'not_found', id };
  }
  return mapSections(definition, (section) =>
    section.id === id ? { ...update(section), id, fields: section.fields } : section,
  );
}

export function updatePage(
  definition: FormDefinition,
  id: ElementId,
  update: (page: Omit<Page, 'sections'>) => Omit<Page, 'sections'>,
): EditResult {
  if (locate(definition, id)?.kind !== 'page') {
    return { error: 'not_found', id };
  }
  return mapPages(definition, (page) =>
    page.id === id ? { ...update(page), id, sections: page.sections } : page,
  );
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

/** Moves a field to `index` within `toSectionId`, which may be the section it is already in. */
export function moveField(
  definition: FormDefinition,
  id: ElementId,
  toSectionId: ElementId,
  index: number,
): EditResult {
  const field = findField(definition, id);
  if (field === undefined) {
    return { error: 'not_found', id };
  }
  if (locate(definition, toSectionId)?.kind !== 'section') {
    return { error: 'invalid_target', id: toSectionId };
  }

  const without = mapSections(definition, (section) => ({
    ...section,
    fields: section.fields.filter((candidate) => candidate.id !== id),
  }));
  return addField(without, toSectionId, field, index);
}

export function moveSection(
  definition: FormDefinition,
  id: ElementId,
  toPageId: ElementId,
  index: number,
): EditResult {
  const from = locate(definition, id);
  if (from?.kind !== 'section') {
    return { error: 'not_found', id };
  }
  if (locate(definition, toPageId)?.kind !== 'page') {
    return { error: 'invalid_target', id: toPageId };
  }
  const sourcePage = definition.pages[from.page]!;
  if (sourcePage.id !== toPageId && sourcePage.sections.length === 1) {
    return { error: 'last_section', page: sourcePage.id };
  }

  const section = sourcePage.sections[from.section!]!;
  const without = mapPages(definition, (page) => ({
    ...page,
    sections: page.sections.filter((candidate) => candidate.id !== id),
  }));
  return addSection(without, toPageId, section, index);
}

export function movePage(definition: FormDefinition, id: ElementId, index: number): EditResult {
  const page = definition.pages.find((candidate) => candidate.id === id);
  if (page === undefined) {
    return { error: 'not_found', id };
  }
  return addPage(
    { ...definition, pages: definition.pages.filter((candidate) => candidate.id !== id) },
    page,
    index,
  );
}

// ---------------------------------------------------------------------------
// Duplicating
// ---------------------------------------------------------------------------

/**
 * Rewrites every field reference in an expression through `map`. References to
 * anything not in the map are left alone, so a copied field still depends on
 * the same original fields outside the copy.
 */
export function remapExpression(
  expression: Expression,
  map: ReadonlyMap<ElementId, ElementId>,
): Expression {
  const id = (field: ElementId) => map.get(field) ?? field;
  switch (expression.kind) {
    case 'answer':
    case 'answered':
      return { ...expression, field: id(expression.field) };
    case 'includes':
      return { ...expression, field: id(expression.field) };
    case 'not':
      return { ...expression, operand: remapExpression(expression.operand, map) };
    case 'all':
    case 'any':
      return {
        ...expression,
        operands: expression.operands.map((operand) => remapExpression(operand, map)),
      };
    case 'compare':
    case 'arithmetic':
      return {
        ...expression,
        left: remapExpression(expression.left, map),
        right: remapExpression(expression.right, map),
      };
    default:
      return expression;
  }
}

function remapField(field: Field, map: ReadonlyMap<ElementId, ElementId>): Field {
  const copy: Record<string, unknown> = { ...field, id: map.get(field.id) ?? field.id };
  if (field.visibleWhen !== undefined) {
    copy.visibleWhen = remapExpression(field.visibleWhen, map);
  }
  if ('calculation' in field && field.calculation !== undefined) {
    copy.calculation = remapExpression(field.calculation, map);
  }
  if (field.rules !== undefined) {
    copy.rules = field.rules.map((rule) => ({
      ...rule,
      assert: remapExpression(rule.assert, map),
    }));
  }
  return copy as Field;
}

/** New ids for every element in a subtree, avoiding everything in `taken`. */
function freshIds(ids: readonly ElementId[], taken: Set<ElementId>): Map<ElementId, ElementId> {
  const map = new Map<ElementId, ElementId>();
  for (const id of ids) {
    const next = generateId(`${id}_copy`, 'field', taken);
    taken.add(next);
    map.set(id, next);
  }
  return map;
}

/**
 * Duplicates a field, a section or a page, directly after the original.
 *
 * Every copied element gets a new id. References *within* the copy are pointed
 * at the copy — duplicating a "Fail → Reason" pair gives a second pair that
 * works on its own rather than one whose "Reason" still watches the first
 * "Fail". References to anything outside the copy are left where they were.
 */
export type DuplicateResult = { definition: FormDefinition; copyId: ElementId } | EditError;

export function duplicate(definition: FormDefinition, id: ElementId): DuplicateResult {
  const at = locate(definition, id);
  if (at === undefined) {
    return { error: 'not_found', id };
  }

  const taken = new Set(allIds(definition));
  const page = definition.pages[at.page]!;

  if (at.kind === 'field') {
    const section = page.sections[at.section!]!;
    const map = freshIds([id], taken);
    const copy = remapField(section.fields[at.field!]!, map);
    const result = addField(definition, section.id, copy, at.field! + 1);
    return isEditError(result) ? result : { definition: result, copyId: copy.id };
  }

  if (at.kind === 'section') {
    const section = page.sections[at.section!]!;
    const map = freshIds([section.id, ...section.fields.map((field) => field.id)], taken);
    const copy: Section = {
      ...section,
      id: map.get(section.id)!,
      ...(section.visibleWhen === undefined
        ? {}
        : { visibleWhen: remapExpression(section.visibleWhen, map) }),
      fields: section.fields.map((field) => remapField(field, map)),
    };
    const result = addSection(definition, page.id, copy, at.section! + 1);
    return isEditError(result) ? result : { definition: result, copyId: copy.id };
  }

  const map = freshIds(
    [
      page.id,
      ...page.sections.flatMap((section) => [
        section.id,
        ...section.fields.map((field) => field.id),
      ]),
    ],
    taken,
  );
  const copy: Page = {
    ...page,
    id: map.get(page.id)!,
    ...(page.visibleWhen === undefined
      ? {}
      : { visibleWhen: remapExpression(page.visibleWhen, map) }),
    sections: page.sections.map((section) => ({
      ...section,
      id: map.get(section.id)!,
      ...(section.visibleWhen === undefined
        ? {}
        : { visibleWhen: remapExpression(section.visibleWhen, map) }),
      fields: section.fields.map((field) => remapField(field, map)),
    })),
  };
  return { definition: addPage(definition, copy, at.page + 1), copyId: copy.id };
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

export interface Reference {
  /** The element whose rule reads the field. */
  from: ElementId;
  where: 'visibleWhen' | 'calculation' | 'rule';
  /** The rule id, when `where` is `rule`. */
  rule?: ElementId;
  /** The field being read. */
  to: ElementId;
}

/**
 * Every rule, anywhere in the form, that reads one of `ids`.
 *
 * The builder shows this before a delete: "Reason is shown depending on
 * Result. Delete Result anyway?" Deleting is still allowed — the compiler will
 * then name every broken rule — but not silently.
 */
export function referencesTo(definition: FormDefinition, ids: readonly ElementId[]): Reference[] {
  const targets = new Set(ids);
  const found: Reference[] = [];
  const scan = (
    from: ElementId,
    where: Reference['where'],
    expression: Expression | undefined,
    rule?: ElementId,
  ) => {
    if (expression === undefined) {
      return;
    }
    for (const to of referencedFields(expression)) {
      if (targets.has(to) && !targets.has(from)) {
        found.push({ from, where, to, ...(rule === undefined ? {} : { rule }) });
      }
    }
  };

  for (const page of definition.pages) {
    scan(page.id, 'visibleWhen', page.visibleWhen);
    for (const section of page.sections) {
      scan(section.id, 'visibleWhen', section.visibleWhen);
      for (const field of section.fields) {
        scan(field.id, 'visibleWhen', field.visibleWhen);
        if ('calculation' in field) {
          scan(field.id, 'calculation', field.calculation);
        }
        for (const rule of field.rules ?? []) {
          scan(field.id, 'rule', rule.assert, rule.id);
        }
      }
    }
  }
  return found;
}

/** The ids an element takes with it when removed. */
export function subtreeIds(definition: FormDefinition, id: ElementId): ElementId[] {
  const at = locate(definition, id);
  if (at === undefined) {
    return [];
  }
  const page = definition.pages[at.page]!;
  if (at.kind === 'field') {
    return [id];
  }
  if (at.kind === 'section') {
    const section = page.sections[at.section!]!;
    return [section.id, ...section.fields.map((field) => field.id)];
  }
  return [
    page.id,
    ...page.sections.flatMap((section) => [section.id, ...section.fields.map((field) => field.id)]),
  ];
}

/**
 * Removes a field, a section or a page, with everything inside it.
 *
 * Refuses to remove the last page or a page's last section, because a
 * definition without one does not have a shape to put a field back into.
 */
export function remove(definition: FormDefinition, id: ElementId): EditResult {
  const at = locate(definition, id);
  if (at === undefined) {
    return { error: 'not_found', id };
  }

  if (at.kind === 'page') {
    return definition.pages.length === 1
      ? { error: 'last_page' }
      : { ...definition, pages: definition.pages.filter((page) => page.id !== id) };
  }

  if (at.kind === 'section') {
    const page = definition.pages[at.page]!;
    if (page.sections.length === 1) {
      return { error: 'last_section', page: page.id };
    }
    return mapPages(definition, (candidate) => ({
      ...candidate,
      sections: candidate.sections.filter((section) => section.id !== id),
    }));
  }

  return mapSections(definition, (section) => ({
    ...section,
    fields: section.fields.filter((field) => field.id !== id),
  }));
}
