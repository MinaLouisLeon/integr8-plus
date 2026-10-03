import {
  type AggregateOperator,
  type ArithmeticOperator,
  describeFieldType,
  type Expression,
  type Field,
  type FormDefinition,
  type Section,
} from '@integr8/form-engine';
import { repeatableSections, repeatingScope } from './subjects';

/**
 * Calculations as a person writes them: "Hours × Rate + Call-out fee".
 *
 * A chain of terms, each a field or a number, joined by operators and worked
 * out left to right — the way a calculator does it, and the way somebody reads
 * the sentence aloud. That is narrower than what the engine can evaluate, on
 * purpose: only what can be shown as a chain can be edited as one, and anything
 * else (written by hand, or by P30's AI) is shown read-only rather than
 * mangled.
 *
 * A term can also read across a repeatable section (P13b): "the total of
 * Output across Radiators", or "the number of entries in Radiators".
 */

export type Term =
  | { kind: 'field'; field: string }
  | { kind: 'number'; value: string }
  | { kind: 'aggregate'; operator: AggregateOperator; section: string; field: string }
  | { kind: 'count'; section: string };

export interface Calculation {
  first: Term;
  rest: { operator: ArithmeticOperator; term: Term }[];
}

export function toCalculation(expression: Expression | undefined): Calculation | undefined {
  if (expression === undefined) {
    return undefined;
  }
  const term = asTerm(expression);
  if (term !== undefined) {
    return { first: term, rest: [] };
  }
  if (expression.kind !== 'arithmetic') {
    return undefined;
  }
  const right = asTerm(expression.right);
  const left = toCalculation(expression.left);
  if (right === undefined || left === undefined) {
    return undefined;
  }
  return {
    first: left.first,
    rest: [...left.rest, { operator: expression.operator, term: right }],
  };
}

export function fromCalculation(calculation: Calculation): Expression {
  return calculation.rest.reduce<Expression>(
    (left, step) => ({
      kind: 'arithmetic',
      operator: step.operator,
      left,
      right: termExpression(step.term),
    }),
    termExpression(calculation.first),
  );
}

function asTerm(expression: Expression): Term | undefined {
  switch (expression.kind) {
    case 'answer':
      return { kind: 'field', field: expression.field };
    case 'number':
      return { kind: 'number', value: expression.value };
    case 'aggregate':
      return {
        kind: 'aggregate',
        operator: expression.operator,
        section: expression.section,
        field: expression.field,
      };
    case 'count':
      return { kind: 'count', section: expression.section };
    default:
      return undefined;
  }
}

function termExpression(term: Term): Expression {
  switch (term.kind) {
    case 'field':
      return { kind: 'answer', field: term.field };
    case 'number':
      return { kind: 'number', value: term.value };
    case 'aggregate':
      return {
        kind: 'aggregate',
        operator: term.operator,
        section: term.section,
        field: term.field,
      };
    case 'count':
      return { kind: 'count', section: term.section };
  }
}

export interface CalculationSources {
  /** Number questions a calculation on this field may read one answer of. */
  fields: Field[];
  /** Repeatable sections it may read across, each with its number questions. */
  sections: { section: Section; numbers: Field[] }[];
}

/**
 * What a calculated field may be worked out from, where it sits: number
 * questions outside every repeatable section, and those of its own entry if it
 * is in one; and, across each other repeatable section, its count and the
 * total, smallest and largest of its number questions.
 */
export function calculationSources(
  definition: FormDefinition,
  fieldId: string,
): CalculationSources {
  const scope = repeatingScope(definition, fieldId);
  const isNumber = (field: Field) =>
    field.id !== fieldId && describeFieldType(field.type).valueType === 'number';
  const fields = definition.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.repeat === undefined || section.id === scope?.id
        ? section.fields.filter(isNumber)
        : [],
    ),
  );
  const sections = repeatableSections(definition)
    .filter((section) => section.id !== scope?.id)
    .map((section) => ({ section, numbers: section.fields.filter(isNumber) }));
  return { fields, sections };
}

/** A term's value in the term dropdown: a field's id, or a `#`-prefixed reading across a section. */
export function termKey(term: Term): string {
  switch (term.kind) {
    case 'field':
      return term.field;
    case 'number':
      return '';
    case 'aggregate':
      return `#${term.operator}:${term.section}:${term.field}`;
    case 'count':
      return `#count:${term.section}`;
  }
}

/** The term a dropdown value stands for. */
export function termFromKey(key: string): Term {
  if (key === '') {
    return { kind: 'number', value: '0' };
  }
  if (!key.startsWith('#')) {
    return { kind: 'field', field: key };
  }
  const [operator = '', section = '', field = ''] = key.slice(1).split(':');
  return operator === 'count'
    ? { kind: 'count', section }
    : { kind: 'aggregate', operator: operator as AggregateOperator, section, field };
}
