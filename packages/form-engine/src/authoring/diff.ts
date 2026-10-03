import { canonicalJson, compareCodeUnits } from '../canonical.js';
import { compareDecimal, parseDecimal } from '../decimal.js';
import type { FormDefinition, Section } from '../definition.js';
import { choiceValues, type Field } from '../field-types.js';
import type { ElementId } from '../ids.js';
import { parseDate, parseDatetime, parseTime } from '../temporal.js';

/**
 * What a draft changes compared with the live version, and what that costs.
 *
 * Two readers. The builder's diff view wants every change, so an admin can see
 * what they are about to publish. The publish dialog wants the *breaking*
 * ones, with a plain statement of what each loses — because, as the plan
 * warns, removing a field that existing submissions answered is perfectly
 * legal and still costs something: those answers stay with the old version,
 * and a report across versions has a gap where that field used to be.
 *
 * Changes are matched by id, which is stable for the life of a form. A field
 * whose label changed is the same field; a field deleted and re-added with the
 * same label is not.
 */

export type ElementKind = 'page' | 'section' | 'field';

export type ChangeKind = 'added' | 'removed' | 'moved' | 'changed';

export interface DefinitionChange {
  kind: ChangeKind;
  elementKind: ElementKind;
  element: ElementId;
  /** For `changed`: the properties that differ, sorted. */
  properties: string[];
}

export type BreakingReason =
  /** Existing answers stay on the old version; reports across versions lose the field. */
  | 'field_removed'
  /** Same id, different type: answers before and after cannot be compared. */
  | 'type_changed'
  /** Answers that chose a removed option no longer match anything offered. */
  | 'option_removed'
  /** A field becomes typed by the engine; values typed before are no longer used. */
  | 'now_calculated'
  /** Drafts that left it blank will not submit. */
  | 'now_required'
  /** Drafts holding a value that was fine may no longer be. */
  | 'constraint_tightened'
  /**
   * The field moved into a repeatable section or out of one, or its section
   * started or stopped repeating (P13b): answers before and after are shaped
   * differently, one answer against a list of entries.
   */
  | 'entries_changed';

export interface BreakingChange {
  /** The field — or, for a change to how a section repeats, the section. */
  field: ElementId;
  reason: BreakingReason;
  /** Who feels it: past submissions in reports, or drafts still being filled. */
  affects: 'reporting' | 'drafts';
  /** The properties involved, or the option values removed. */
  detail: string[];
}

export interface DefinitionDiff {
  titleChanged: boolean;
  changes: DefinitionChange[];
  breaking: BreakingChange[];
}

interface Placed {
  kind: ElementKind;
  parent: ElementId | undefined;
  index: number;
  own: Record<string, unknown>;
  field: Field | undefined;
  /** For a field: whether its section repeats. For a section: its repeat. */
  repeats: boolean;
  repeat: Section['repeat'];
}

/** Every element with its position and its own properties, children excluded. */
function index(definition: FormDefinition): Map<ElementId, Placed> {
  const placed = new Map<ElementId, Placed>();
  definition.pages.forEach((page, pageIndex) => {
    const { sections, ...ownPage } = page;
    placed.set(page.id, {
      kind: 'page',
      parent: undefined,
      index: pageIndex,
      own: ownPage,
      field: undefined,
      repeats: false,
      repeat: undefined,
    });
    sections.forEach((section, sectionIndex) => {
      const { fields, ...ownSection } = section;
      placed.set(section.id, {
        kind: 'section',
        parent: page.id,
        index: sectionIndex,
        own: ownSection,
        field: undefined,
        repeats: section.repeat !== undefined,
        repeat: section.repeat,
      });
      fields.forEach((field, fieldIndex) => {
        placed.set(field.id, {
          kind: 'field',
          parent: section.id,
          index: fieldIndex,
          own: { ...field },
          field,
          repeats: section.repeat !== undefined,
          repeat: undefined,
        });
      });
    });
  });
  return placed;
}

function changedProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => canonical(before[key]) !== canonical(after[key]))
    .sort(compareCodeUnits);
}

/** Canonical JSON, tolerating the absence of a value. Definitions carry no doubles. */
function canonical(value: unknown): string {
  return value === undefined ? '<absent>' : canonicalJson(value);
}

export function diffDefinitions(
  live: FormDefinition | undefined,
  draft: FormDefinition,
): DefinitionDiff {
  const before = live === undefined ? new Map<ElementId, Placed>() : index(live);
  const after = index(draft);
  const changes: DefinitionChange[] = [];
  const breaking: BreakingChange[] = [];

  // Draft order first, so the diff reads top to bottom like the form…
  for (const [id, next] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      changes.push({ kind: 'added', elementKind: next.kind, element: id, properties: [] });
      continue;
    }

    if (previous.parent !== next.parent || previous.index !== next.index) {
      changes.push({ kind: 'moved', elementKind: next.kind, element: id, properties: [] });
    }
    const properties = changedProperties(previous.own, next.own);
    if (properties.length > 0) {
      changes.push({ kind: 'changed', elementKind: next.kind, element: id, properties });
    }

    if (previous.field !== undefined && next.field !== undefined) {
      if (previous.repeats !== next.repeats) {
        breaking.push({ field: id, reason: 'entries_changed', affects: 'reporting', detail: [] });
      } else {
        breaking.push(...breakingBetween(previous.field, next.field));
      }
    }
    if (next.kind === 'section' && previous.repeat !== undefined && next.repeat !== undefined) {
      const tightened = [
        ...((next.repeat.minEntries ?? 0) > (previous.repeat.minEntries ?? 0)
          ? ['minEntries']
          : []),
        ...(next.repeat.maxEntries < previous.repeat.maxEntries ? ['maxEntries'] : []),
      ];
      if (tightened.length > 0) {
        breaking.push({
          field: id,
          reason: 'constraint_tightened',
          affects: 'drafts',
          detail: tightened,
        });
      }
    }
  }

  // …then whatever the draft no longer has, in the live version's order.
  for (const [id, previous] of before) {
    if (!after.has(id)) {
      changes.push({ kind: 'removed', elementKind: previous.kind, element: id, properties: [] });
      if (previous.field !== undefined) {
        breaking.push({ field: id, reason: 'field_removed', affects: 'reporting', detail: [] });
      }
    }
  }

  return {
    titleChanged: live !== undefined && canonical(live.title) !== canonical(draft.title),
    changes,
    breaking,
  };
}

// ---------------------------------------------------------------------------
// Breaking changes to one field
// ---------------------------------------------------------------------------

function breakingBetween(before: Field, after: Field): BreakingChange[] {
  const found: BreakingChange[] = [];
  const push = (reason: BreakingReason, affects: BreakingChange['affects'], detail: string[]) => {
    found.push({ field: after.id, reason, affects, detail });
  };

  if (before.type !== after.type) {
    push('type_changed', 'reporting', [before.type, after.type]);
    // Nothing else about two different types is comparable.
    return found;
  }

  const beforeOptions = choiceValues(before);
  const afterOptions = choiceValues(after);
  if (beforeOptions !== undefined && afterOptions !== undefined) {
    const removed = beforeOptions.filter((value) => !afterOptions.includes(value));
    if (removed.length > 0) {
      push('option_removed', 'reporting', removed);
    }
  }

  const calculated = (field: Field) => 'calculation' in field && field.calculation !== undefined;
  if (!calculated(before) && calculated(after)) {
    push('now_calculated', 'reporting', ['calculation']);
  }

  if (before.required !== true && after.required === true) {
    push('now_required', 'drafts', ['required']);
  }

  const tightened = tightenedConstraints(before, after);
  if (tightened.length > 0) {
    push('constraint_tightened', 'drafts', tightened);
  }

  return found;
}

type Direction = 'raise_is_tighter' | 'lower_is_tighter';

/** Numeric limits shared by several field types, and which way is stricter. */
const NUMERIC_LIMITS: Record<string, Direction> = {
  minLength: 'raise_is_tighter',
  maxLength: 'lower_is_tighter',
  minSelected: 'raise_is_tighter',
  maxSelected: 'lower_is_tighter',
  minFiles: 'raise_is_tighter',
  maxFiles: 'lower_is_tighter',
  maxFileBytes: 'lower_is_tighter',
  decimalPlaces: 'lower_is_tighter',
  scale: 'lower_is_tighter',
};

/**
 * Limits that got stricter. A limit that appears where there was none is
 * stricter; one that disappears is not.
 */
function tightenedConstraints(before: Field, after: Field): string[] {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const tighter: string[] = [];

  for (const [property, direction] of Object.entries(NUMERIC_LIMITS)) {
    const was = b[property];
    const now = a[property];
    if (typeof now !== 'number') {
      continue;
    }
    if (typeof was !== 'number' || (direction === 'raise_is_tighter' ? now > was : now < was)) {
      tighter.push(property);
    }
  }

  const ordered = orderedBounds(before);
  if (ordered !== undefined) {
    for (const [property, direction] of [
      [ordered.min, 'raise_is_tighter'],
      [ordered.max, 'lower_is_tighter'],
    ] as const) {
      const was = b[property];
      const now = a[property];
      if (now === undefined) {
        continue;
      }
      const order = was === undefined ? undefined : ordered.compare(was, now);
      if (order === undefined || (direction === 'raise_is_tighter' ? order < 0 : order > 0)) {
        tighter.push(property);
      }
    }
  }

  if (
    before.type === 'text' &&
    after.type === 'text' &&
    after.pattern !== undefined &&
    canonical(before.pattern) !== canonical(after.pattern)
  ) {
    tighter.push('pattern');
  }
  if (before.type === 'gps' && after.type === 'gps' && after.maxAccuracyMeters !== undefined) {
    const was =
      before.maxAccuracyMeters === undefined ? undefined : parseDecimal(before.maxAccuracyMeters);
    const now = parseDecimal(after.maxAccuracyMeters);
    if (now !== undefined && (was === undefined || compareDecimal(now, was) < 0)) {
      tighter.push('maxAccuracyMeters');
    }
  }
  if (before.type === 'file' && after.type === 'file' && after.acceptedTypes !== undefined) {
    const was = before.acceptedTypes;
    if (
      was === undefined ||
      after.acceptedTypes.some((type) => !was.includes(type)) ||
      was.some((type) => !after.acceptedTypes!.includes(type))
    ) {
      tighter.push('acceptedTypes');
    }
  }

  return tighter.sort(compareCodeUnits);
}

function orderedBounds(
  field: Field,
):
  | { min: string; max: string; compare: (a: unknown, b: unknown) => number | undefined }
  | undefined {
  const compareWith = (parse: (text: string) => number | undefined) => (a: unknown, b: unknown) => {
    const left = typeof a === 'string' ? parse(a) : undefined;
    const right = typeof b === 'string' ? parse(b) : undefined;
    return left === undefined || right === undefined ? undefined : Math.sign(left - right);
  };

  switch (field.type) {
    case 'number':
      return {
        min: 'min',
        max: 'max',
        compare: (a, b) =>
          typeof a === 'number' && typeof b === 'number' ? Math.sign(a - b) : undefined,
      };
    case 'decimal':
      return {
        min: 'min',
        max: 'max',
        compare: (a, b) => {
          const left = typeof a === 'string' ? parseDecimal(a) : undefined;
          const right = typeof b === 'string' ? parseDecimal(b) : undefined;
          return left === undefined || right === undefined
            ? undefined
            : compareDecimal(left, right);
        },
      };
    case 'date':
      return { min: 'earliest', max: 'latest', compare: compareWith(parseDate) };
    case 'time':
      return { min: 'earliest', max: 'latest', compare: compareWith(parseTime) };
    case 'datetime':
      return { min: 'earliest', max: 'latest', compare: compareWith(parseDatetime) };
    default:
      return undefined;
  }
}
