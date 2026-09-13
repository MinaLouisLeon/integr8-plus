import type { z } from 'zod';
import { parseDecimal } from './decimal.js';
import { type FormDefinition, formDefinitionSchema, LIMITS } from './definition.js';
import { type Expression, measure, referencedFields } from './expression.js';
import {
  choiceValues,
  describeFieldType,
  type Field,
  fieldConfigIssues,
  isCalculated,
  type ValueType,
} from './field-types.js';
import type { ElementId } from './ids.js';
import { parseDate, parseDatetime, parseTime } from './temporal.js';

/**
 * Turning a definition into something that can be evaluated — or refusing to.
 *
 * This runs when a form is published, and it is the reason "publishing an
 * invalid definition is impossible" (P07) can be true: everything that could go
 * wrong at fill-in time and can be known in advance is caught here, with a
 * message that names the fields involved.
 *
 * - the structure matches the schema
 * - every id is unique
 * - every rule refers to a field that exists, with a value of the right type
 * - no field, section or page depends on itself, however indirectly
 * - each field's own configuration is coherent
 *
 * A compiled form also fixes the order evaluation happens in, so no runtime
 * ever has to discover it — or discover it differently.
 */

export type ElementKind = 'page' | 'section' | 'field';

export interface ElementInfo {
  id: ElementId;
  kind: ElementKind;
  /** The section a field is in, or the page a section is in. */
  parent: ElementId | undefined;
  visibleWhen: Expression | undefined;
  /** Position in the definition, pages then their sections then their fields. */
  index: number;
  /** Where it sits, e.g. `pages[0].sections[1].fields[2]`. */
  path: string;
  field: Field | undefined;
}

export interface CompiledForm {
  readonly definition: FormDefinition;
  /** Every field, in the order a person reads them. */
  readonly fields: readonly Field[];
  readonly elements: ReadonlyMap<ElementId, ElementInfo>;
  /** Dependencies before dependents. */
  readonly evaluationOrder: readonly ElementId[];
}

export const DEFINITION_ISSUE_CODES = [
  'invalid_structure',
  'too_large',
  'duplicate_id',
  'invalid_field_config',
  'unknown_field',
  'not_a_field',
  'type_mismatch',
  'invalid_literal',
  'unknown_option',
  'expression_too_complex',
  'circular_dependency',
] as const;

export type DefinitionIssueCode = (typeof DEFINITION_ISSUE_CODES)[number];

export interface DefinitionIssue {
  code: DefinitionIssueCode;
  /** For the person publishing. The builder maps `code` to its own copy. */
  message: string;
  /** Where in the definition, e.g. `pages[0].sections[1].fields[2].visibleWhen`. */
  path: string;
  /** The ids involved. For a cycle, every element on it, in order. */
  elements: ElementId[];
}

export type CompileResult =
  { ok: true; form: CompiledForm } | { ok: false; issues: DefinitionIssue[] };

export function compileDefinition(input: unknown): CompileResult {
  const parsed = formDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(structureIssue) };
  }

  const definition = parsed.data;
  const issues: DefinitionIssue[] = [];
  const elements = collectElements(definition, issues);
  const fields = [...elements.values()].flatMap((element) =>
    element.field === undefined ? [] : [element.field],
  );

  if (fields.length > LIMITS.fieldsTotal) {
    issues.push({
      code: 'too_large',
      message: `A form may have at most ${String(LIMITS.fieldsTotal)} fields; this one has ${String(fields.length)}`,
      path: 'pages',
      elements: [],
    });
  }

  // Duplicate ids make every later check ambiguous, so stop before them.
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  for (const element of elements.values()) {
    checkElement(element, elements, issues);
  }

  // A cycle can only be traced reliably through references that resolve.
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const ordering = orderElements(elements);
  if (ordering.cycles.length > 0) {
    return { ok: false, issues: ordering.cycles };
  }

  return {
    ok: true,
    form: Object.freeze({ definition, fields, elements, evaluationOrder: ordering.order }),
  };
}

function structureIssue(issue: z.core.$ZodIssue): DefinitionIssue {
  return {
    code: 'invalid_structure',
    message: issue.message,
    path: formatPath(issue.path),
    elements: [],
  };
}

function formatPath(path: readonly PropertyKey[]): string {
  let text = '';
  for (const segment of path) {
    text +=
      typeof segment === 'number'
        ? `[${String(segment)}]`
        : `${text === '' ? '' : '.'}${String(segment)}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function collectElements(
  definition: FormDefinition,
  issues: DefinitionIssue[],
): Map<ElementId, ElementInfo> {
  const elements = new Map<ElementId, ElementInfo>();
  const paths = new Map<ElementId, string>();

  const add = (info: Omit<ElementInfo, 'index' | 'path'>, path: string) => {
    const existing = paths.get(info.id);
    if (existing !== undefined) {
      issues.push({
        code: 'duplicate_id',
        message: `The id "${info.id}" is used twice, at ${existing} and ${path}. Pages, sections and fields share one set of ids.`,
        path,
        elements: [info.id],
      });
      return;
    }
    paths.set(info.id, path);
    elements.set(info.id, { ...info, index: elements.size, path });
  };

  definition.pages.forEach((page, pageIndex) => {
    const pagePath = `pages[${String(pageIndex)}]`;
    add(
      {
        id: page.id,
        kind: 'page',
        parent: undefined,
        visibleWhen: page.visibleWhen,
        field: undefined,
      },
      pagePath,
    );

    page.sections.forEach((section, sectionIndex) => {
      const sectionPath = `${pagePath}.sections[${String(sectionIndex)}]`;
      add(
        {
          id: section.id,
          kind: 'section',
          parent: page.id,
          visibleWhen: section.visibleWhen,
          field: undefined,
        },
        sectionPath,
      );

      section.fields.forEach((field, fieldIndex) => {
        add(
          {
            id: field.id,
            kind: 'field',
            parent: section.id,
            visibleWhen: field.visibleWhen,
            field,
          },
          `${sectionPath}.fields[${String(fieldIndex)}]`,
        );
      });
    });
  });

  return elements;
}

function checkElement(
  element: ElementInfo,
  elements: ReadonlyMap<ElementId, ElementInfo>,
  issues: DefinitionIssue[],
): void {
  const path = element.path;

  if (element.visibleWhen !== undefined) {
    checkExpression(
      element.visibleWhen,
      'boolean',
      `${path}.visibleWhen`,
      element.id,
      elements,
      issues,
    );
  }

  const field = element.field;
  if (field === undefined) {
    return;
  }

  for (const issue of fieldConfigIssues(field)) {
    issues.push({
      code: 'invalid_field_config',
      message: `Field "${field.id}": ${issue.message}`,
      path: `${path}.${issue.property}`,
      elements: [field.id],
    });
  }

  if (
    isCalculated(field) &&
    (field.type === 'number' || field.type === 'decimal') &&
    field.calculation !== undefined
  ) {
    checkExpression(field.calculation, 'number', `${path}.calculation`, field.id, elements, issues);
  }

  (field.rules ?? []).forEach((rule, ruleIndex) => {
    checkExpression(
      rule.assert,
      'boolean',
      `${path}.rules[${String(ruleIndex)}].assert`,
      field.id,
      elements,
      issues,
    );
  });
}

// ---------------------------------------------------------------------------
// Expressions: size and types
// ---------------------------------------------------------------------------

function checkExpression(
  expression: Expression,
  expected: 'boolean' | 'number',
  path: string,
  owner: ElementId,
  elements: ReadonlyMap<ElementId, ElementInfo>,
  issues: DefinitionIssue[],
): void {
  const size = measure(expression);
  if (size.nodes > LIMITS.expressionNodes || size.depth > LIMITS.expressionDepth) {
    issues.push({
      code: 'expression_too_complex',
      message: `The rule on "${owner}" is too large (${String(size.nodes)} parts, ${String(size.depth)} levels deep). Split it, or simplify it.`,
      path,
      elements: [owner],
    });
    return;
  }

  const found = typeOf(expression, path, elements, issues);
  if (found !== undefined && found !== expected) {
    issues.push({
      code: 'type_mismatch',
      message:
        expected === 'boolean'
          ? `The condition on "${owner}" must be true or false, but it produces a ${found} value`
          : `The calculation for "${owner}" must produce a number, but it produces a ${found} value`,
      path,
      elements: [owner],
    });
  }
}

type RuleType = Exclude<ValueType, 'opaque'> | 'opaque';

const ORDERED: ReadonlySet<RuleType> = new Set(['number', 'date', 'time', 'datetime']);
const EQUATABLE: ReadonlySet<RuleType> = new Set([
  'number',
  'date',
  'time',
  'datetime',
  'text',
  'boolean',
]);

/**
 * The static type of an expression, reporting every problem on the way down.
 * `undefined` means "already reported"; callers do not pile a second message on.
 */
function typeOf(
  expression: Expression,
  path: string,
  elements: ReadonlyMap<ElementId, ElementInfo>,
  issues: DefinitionIssue[],
): RuleType | undefined {
  const report = (code: DefinitionIssueCode, message: string, ids: ElementId[] = []) => {
    issues.push({ code, message, path, elements: ids });
    return undefined;
  };

  const fieldFor = (id: ElementId): Field | undefined => {
    const element = elements.get(id);
    if (element === undefined) {
      report('unknown_field', `A rule refers to "${id}", which is not in this form`, [id]);
      return undefined;
    }
    if (element.field === undefined) {
      report('not_a_field', `A rule refers to "${id}", which is a ${element.kind}, not a field`, [
        id,
      ]);
      return undefined;
    }
    return element.field;
  };

  switch (expression.kind) {
    case 'text':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'number':
      return parseDecimal(expression.value) === undefined
        ? report('invalid_literal', `"${expression.value}" is not a number a rule can use`)
        : 'number';
    case 'date':
      return parseDate(expression.value) === undefined
        ? report('invalid_literal', `"${expression.value}" is not a date in the form YYYY-MM-DD`)
        : 'date';
    case 'time':
      return parseTime(expression.value) === undefined
        ? report('invalid_literal', `"${expression.value}" is not a time in the form HH:MM`)
        : 'time';
    case 'datetime':
      return parseDatetime(expression.value) === undefined
        ? report('invalid_literal', `"${expression.value}" is not a date and time with an offset`)
        : 'datetime';
    case 'today':
      return 'date';
    case 'answer': {
      const field = fieldFor(expression.field);
      return field === undefined ? undefined : describeFieldType(field.type).valueType;
    }
    case 'answered':
      return fieldFor(expression.field) === undefined ? undefined : 'boolean';
    case 'includes': {
      const field = fieldFor(expression.field);
      if (field === undefined) {
        return undefined;
      }
      if (field.type !== 'multi_select') {
        return report(
          'type_mismatch',
          `"includes" needs a multi-select field; "${field.id}" is ${field.type}`,
          [field.id],
        );
      }
      if (!field.options.some((option) => option.value === expression.option)) {
        return report('unknown_option', `"${field.id}" has no option "${expression.option}"`, [
          field.id,
        ]);
      }
      return 'boolean';
    }
    case 'not': {
      const operand = typeOf(expression.operand, path, elements, issues);
      if (operand !== undefined && operand !== 'boolean') {
        return report('type_mismatch', `"not" needs a true-or-false value, not a ${operand} value`);
      }
      return operand === undefined ? undefined : 'boolean';
    }
    case 'all':
    case 'any': {
      let broken = false;
      for (const operand of expression.operands) {
        const type = typeOf(operand, path, elements, issues);
        if (type === undefined) {
          broken = true;
        } else if (type !== 'boolean') {
          report(
            'type_mismatch',
            `Every part of "${expression.kind}" must be true or false, not a ${type} value`,
          );
          broken = true;
        }
      }
      return broken ? undefined : 'boolean';
    }
    case 'compare':
      return compareType(expression, path, elements, issues, report);
    case 'arithmetic': {
      const left = typeOf(expression.left, path, elements, issues);
      const right = typeOf(expression.right, path, elements, issues);
      if (left === undefined || right === undefined) {
        return undefined;
      }
      if (left !== 'number' || right !== 'number') {
        return report(
          'type_mismatch',
          `"${expression.operator}" needs two numbers, not ${left} and ${right}`,
        );
      }
      return 'number';
    }
  }
}

function compareType(
  expression: Extract<Expression, { kind: 'compare' }>,
  path: string,
  elements: ReadonlyMap<ElementId, ElementInfo>,
  issues: DefinitionIssue[],
  report: (code: DefinitionIssueCode, message: string, ids?: ElementId[]) => undefined,
): RuleType | undefined {
  const left = typeOf(expression.left, path, elements, issues);
  const right = typeOf(expression.right, path, elements, issues);
  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (left !== right) {
    return report('type_mismatch', `A ${left} value cannot be compared with a ${right} value`);
  }
  if (expression.operator === 'eq' || expression.operator === 'ne') {
    if (!EQUATABLE.has(left)) {
      return report(
        'type_mismatch',
        left === 'options'
          ? 'A multi-select answer is tested with "includes", not compared'
          : 'A photo, file, signature or location can only be tested for whether it was given',
      );
    }
  } else if (!ORDERED.has(left)) {
    return report(
      'type_mismatch',
      `A ${left} value has no order, so "${expression.operator}" does not apply`,
    );
  }

  // "Result is 'fial'" can never be true. Catch the typo at publish time.
  for (const [side, other] of [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ] as const) {
    if (side.kind === 'answer' && other.kind === 'text') {
      const field = elements.get(side.field)?.field;
      const offered = field === undefined ? undefined : choiceValues(field);
      if (field !== undefined && offered !== undefined && !offered.includes(other.value)) {
        return report('unknown_option', `"${field.id}" has no option "${other.value}"`, [field.id]);
      }
    }
  }

  return 'boolean';
}

// ---------------------------------------------------------------------------
// Dependencies: cycles and order
// ---------------------------------------------------------------------------

type DependencyReason = 'inside' | 'shown_when' | 'calculated_from';

interface Dependency {
  on: ElementId;
  reason: DependencyReason;
}

/**
 * What each element needs to know before it can be evaluated.
 *
 * - A section's visibility needs its page's; a field's needs its section's.
 * - Anything with `visibleWhen` needs the fields its condition reads.
 * - A calculated field needs the fields its calculation reads.
 *
 * Reading another field means needing its *effective* value, which is empty if
 * that field is hidden — so reading a field transitively depends on that
 * field's own visibility too, and the graph captures it without special cases.
 *
 * Custom validation rules are deliberately absent. They run once every value
 * is known and change none of them, so they cannot take part in a cycle.
 */
function dependenciesOf(element: ElementInfo): Dependency[] {
  const dependencies: Dependency[] = [];
  const push = (on: ElementId, reason: DependencyReason) => {
    if (!dependencies.some((dependency) => dependency.on === on && dependency.reason === reason)) {
      dependencies.push({ on, reason });
    }
  };

  if (element.parent !== undefined) {
    push(element.parent, 'inside');
  }
  if (element.visibleWhen !== undefined) {
    for (const id of referencedFields(element.visibleWhen)) {
      push(id, 'shown_when');
    }
  }
  const field = element.field;
  if (
    field !== undefined &&
    (field.type === 'number' || field.type === 'decimal') &&
    field.calculation !== undefined
  ) {
    for (const id of referencedFields(field.calculation)) {
      push(id, 'calculated_from');
    }
  }
  return dependencies;
}

const REASON_TEXT: Record<DependencyReason, string> = {
  inside: 'is inside',
  shown_when: 'is shown depending on',
  calculated_from: 'is calculated from',
};

function orderElements(elements: ReadonlyMap<ElementId, ElementInfo>): {
  order: ElementId[];
  cycles: DefinitionIssue[];
} {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<ElementId, number>();
  const order: ElementId[] = [];
  const cycles: DefinitionIssue[] = [];
  const reported = new Set<string>();

  // Iterative, so a long chain of dependencies cannot overflow the stack of the
  // smallest engine this runs in.
  for (const root of elements.keys()) {
    if ((colour.get(root) ?? WHITE) !== WHITE) {
      continue;
    }

    const stack: {
      id: ElementId;
      dependencies: Dependency[];
      next: number;
      via: DependencyReason | undefined;
    }[] = [];
    const enter = (id: ElementId, via: DependencyReason | undefined) => {
      colour.set(id, GREY);
      stack.push({ id, dependencies: dependenciesOf(elements.get(id)!), next: 0, via });
    };
    enter(root, undefined);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const dependency = frame.dependencies[frame.next];

      if (dependency === undefined) {
        colour.set(frame.id, BLACK);
        order.push(frame.id);
        stack.pop();
        continue;
      }
      frame.next += 1;

      const state = colour.get(dependency.on) ?? WHITE;
      if (state === WHITE) {
        enter(dependency.on, dependency.reason);
      } else if (state === GREY) {
        const issue = describeCycle(stack, dependency, elements);
        if (!reported.has(issue.key)) {
          reported.add(issue.key);
          cycles.push(issue.issue);
        }
      }
    }
  }

  return { order, cycles };
}

function describeCycle(
  stack: readonly {
    id: ElementId;
    via: DependencyReason | undefined;
    dependencies: Dependency[];
    next: number;
  }[],
  closing: Dependency,
  elements: ReadonlyMap<ElementId, ElementInfo>,
): { key: string; issue: DefinitionIssue } {
  const start = stack.findIndex((frame) => frame.id === closing.on);
  const frames = stack.slice(start);

  // Each hop: frames[i] depends on frames[i+1] for the reason recorded when
  // frames[i+1] was entered; the last hop closes back to the first element.
  const hops = frames.map((frame, index) => ({
    from: frame.id,
    to: frames[index + 1]?.id ?? closing.on,
    reason: frames[index + 1]?.via ?? closing.reason,
  }));

  // Rotate to start at the element that appears first in the definition, so the
  // same cycle found from two starting points is reported once, the same way.
  const first = hops.reduce(
    (best, hop, index) =>
      (elements.get(hop.from)?.index ?? 0) < (elements.get(hops[best]!.from)?.index ?? 0)
        ? index
        : best,
    0,
  );
  const rotated = [...hops.slice(first), ...hops.slice(0, first)];

  const label = (id: ElementId) => `${elements.get(id)?.kind ?? 'element'} "${id}"`;
  const ids = rotated.map((hop) => hop.from);
  const sentence =
    rotated.length === 1 && rotated[0]!.from === rotated[0]!.to
      ? `${label(rotated[0]!.from)} ${REASON_TEXT[rotated[0]!.reason]} itself`
      : rotated
          .map((hop) => `${label(hop.from)} ${REASON_TEXT[hop.reason]} ${label(hop.to)}`)
          .join(', and ');

  return {
    key: ids.join('>'),
    issue: {
      code: 'circular_dependency',
      message: `Circular rule: ${sentence}. None of these can be worked out until another one is.`,
      path: elements.get(ids[0]!)?.path ?? '',
      elements: ids,
    },
  };
}
