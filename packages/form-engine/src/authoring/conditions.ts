import { parseDecimal } from '../decimal.js';
import type { Expression } from '../expression.js';
import { choiceValues, describeFieldType, type Field } from '../field-types.js';
import type { ElementId } from '../ids.js';
import { parseDate, parseDatetime, parseTime } from '../temporal.js';

/**
 * Conditions as a person says them.
 *
 * "Show *Reason for failure* when *Result* is *Fail*." The builder never shows
 * an expression; it shows a list of clauses — a field, an operator named in
 * words, a value — joined by "all of" or "any of". This module turns that list
 * into the P06 syntax tree and back.
 *
 * The plan is emphatic that an expression box would turn the builder back into
 * a developer tool, so the mapping is deliberately narrow: only shapes a person
 * can build here can be read back into clauses. Anything else — an expression
 * written by P30's AI generation, or by hand — comes back `undefined`, and the
 * builder shows it as a read-only rule rather than guessing at a sentence.
 *
 * ## Entries (P13b)
 *
 * A question asked once per entry is read from outside its section with a
 * quantifier — "when *any* radiator's result is fail", "when *every*
 * radiator's result is pass" — and a repeatable section itself can be counted:
 * "when the number of radiators is at least 2".
 */

export const CONDITION_OPERATORS = [
  'is',
  'is_not',
  'is_answered',
  'is_not_answered',
  'is_checked',
  'is_not_checked',
  'is_greater_than',
  'is_less_than',
  'is_at_least',
  'is_at_most',
  'is_before',
  'is_after',
  'is_before_today',
  'is_after_today',
  'includes',
  'does_not_include',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface ConditionClause {
  field: ElementId;
  operator: ConditionOperator;
  /** Absent for operators that take none: answered, checked, relative to today. */
  value?: string;
  /**
   * Compare against another field's answer instead of a fixed value — "Left
   * site must be after Arrived". Takes precedence over `value`. Both fields
   * must give the same kind of value.
   */
  valueField?: ElementId;
  /**
   * For a question asked once per entry, read from outside its entries: whether
   * the clause must hold for any entry or for every one.
   */
  entries?: { section: ElementId; quantifier: 'some' | 'every' };
  /**
   * Instead of a question, the number of entries in `field`, a repeatable
   * section — compared with a whole number.
   */
  subject?: 'entry_count';
}

/** Operators that can compare one answer with another. */
const FIELD_COMPARABLE: ReadonlySet<ConditionOperator> = new Set([
  'is',
  'is_not',
  'is_greater_than',
  'is_less_than',
  'is_at_least',
  'is_at_most',
  'is_before',
  'is_after',
]);

export function canCompareWithField(operator: ConditionOperator): boolean {
  return FIELD_COMPARABLE.has(operator);
}

export interface ConditionModel {
  match: 'all' | 'any';
  clauses: ConditionClause[];
}

/** How the number of entries can be compared. */
export const ENTRY_COUNT_OPERATORS: readonly ConditionOperator[] = [
  'is',
  'is_not',
  'is_greater_than',
  'is_less_than',
  'is_at_least',
  'is_at_most',
];

/** Operators that take no value. */
const UNARY: ReadonlySet<ConditionOperator> = new Set([
  'is_answered',
  'is_not_answered',
  'is_checked',
  'is_not_checked',
  'is_before_today',
  'is_after_today',
]);

export function takesValue(operator: ConditionOperator): boolean {
  return !UNARY.has(operator);
}

/**
 * The operators that make sense for a field, in the order the builder offers
 * them. A photo can only be "answered"; a number can be "greater than"; a date
 * can be "before today".
 */
export function operatorsFor(field: Field): ConditionOperator[] {
  const presence: ConditionOperator[] = ['is_answered', 'is_not_answered'];
  switch (describeFieldType(field.type).valueType) {
    case 'boolean':
      return ['is_checked', 'is_not_checked'];
    case 'text':
      return ['is', 'is_not', ...presence];
    case 'number':
      return [
        'is',
        'is_not',
        'is_greater_than',
        'is_less_than',
        'is_at_least',
        'is_at_most',
        ...presence,
      ];
    case 'date':
      return ['is', 'is_before', 'is_after', 'is_before_today', 'is_after_today', ...presence];
    case 'time':
    case 'datetime':
      return ['is', 'is_before', 'is_after', ...presence];
    case 'options':
      return ['includes', 'does_not_include', ...presence];
    case 'opaque':
      return presence;
  }
}

// ---------------------------------------------------------------------------
// Clauses → expression
// ---------------------------------------------------------------------------

function literal(field: Field, value: string): Expression {
  switch (describeFieldType(field.type).valueType) {
    case 'number':
      return { kind: 'number', value };
    case 'date':
      return { kind: 'date', value };
    case 'time':
      return { kind: 'time', value };
    case 'datetime':
      return { kind: 'datetime', value };
    default:
      return { kind: 'text', value };
  }
}

function clauseExpression(clause: ConditionClause, field: Field): Expression {
  const answer: Expression = { kind: 'answer', field: clause.field };
  const answered: Expression = { kind: 'answered', field: clause.field };
  const compare = (
    operator: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge',
    right: Expression,
  ): Expression => ({
    kind: 'compare',
    operator,
    left: answer,
    right,
  });
  const value = (): Expression =>
    clause.valueField !== undefined && FIELD_COMPARABLE.has(clause.operator)
      ? { kind: 'answer', field: clause.valueField }
      : literal(field, clause.value ?? '');

  switch (clause.operator) {
    case 'is':
      return compare('eq', value());
    case 'is_not':
      return compare('ne', value());
    case 'is_answered':
      return answered;
    case 'is_not_answered':
      return { kind: 'not', operand: answered };
    case 'is_checked':
      return compare('eq', { kind: 'boolean', value: true });
    case 'is_not_checked':
      // Unticked, or never touched. A person saying "when it is not checked"
      // means both, and a bare comparison would be unknown on a blank form.
      return {
        kind: 'any',
        operands: [
          { kind: 'not', operand: answered },
          compare('eq', { kind: 'boolean', value: false }),
        ],
      };
    case 'is_greater_than':
    case 'is_after':
      return compare('gt', value());
    case 'is_less_than':
    case 'is_before':
      return compare('lt', value());
    case 'is_at_least':
      return compare('ge', value());
    case 'is_at_most':
      return compare('le', value());
    case 'is_before_today':
      return compare('lt', { kind: 'today' });
    case 'is_after_today':
      return compare('gt', { kind: 'today' });
    case 'includes':
      return { kind: 'includes', field: clause.field, option: clause.value ?? '' };
    case 'does_not_include':
      return {
        kind: 'not',
        operand: { kind: 'includes', field: clause.field, option: clause.value ?? '' },
      };
  }
}

/**
 * The expression a set of clauses means, or `undefined` for no clauses — which
 * is "always shown", stored as the absence of a condition.
 *
 * `fields` resolves a clause's field so its value becomes the right kind of
 * literal: "5" next to a number field is a number, next to a text field text.
 */
function entryCountExpression(clause: ConditionClause): Expression | undefined {
  const operator = {
    is: 'eq',
    is_not: 'ne',
    is_greater_than: 'gt',
    is_less_than: 'lt',
    is_at_least: 'ge',
    is_at_most: 'le',
  }[clause.operator as string] as 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | undefined;
  return operator === undefined
    ? undefined
    : {
        kind: 'compare',
        operator,
        left: { kind: 'count', section: clause.field },
        right: { kind: 'number', value: clause.value ?? '' },
      };
}

export function toExpression(
  model: ConditionModel,
  field: (id: ElementId) => Field | undefined,
): Expression | undefined {
  const operands = model.clauses.flatMap((clause): Expression[] => {
    if (clause.subject === 'entry_count') {
      const counted = entryCountExpression(clause);
      return counted === undefined ? [] : [counted];
    }
    const target = field(clause.field);
    if (target === undefined) {
      return [];
    }
    const expression = clauseExpression(clause, target);
    return [
      clause.entries === undefined
        ? expression
        : {
            kind: clause.entries.quantifier,
            section: clause.entries.section,
            condition: expression,
          },
    ];
  });

  if (operands.length === 0) {
    return undefined;
  }
  if (operands.length === 1) {
    return operands[0];
  }
  return { kind: model.match, operands };
}

// ---------------------------------------------------------------------------
// Expression → clauses
// ---------------------------------------------------------------------------

const COMPARISONS: Record<string, ConditionOperator | undefined> = {
  eq: 'is',
  ne: 'is_not',
  gt: 'is_greater_than',
  lt: 'is_less_than',
  ge: 'is_at_least',
  le: 'is_at_most',
};

function readClause(
  expression: Expression,
  field: (id: ElementId) => Field | undefined,
): ConditionClause | undefined {
  switch (expression.kind) {
    case 'some':
    case 'every': {
      const inner = readClause(expression.condition, field);
      return inner === undefined || inner.entries !== undefined || inner.subject !== undefined
        ? undefined
        : { ...inner, entries: { section: expression.section, quantifier: expression.kind } };
    }
    case 'answered':
      return { field: expression.field, operator: 'is_answered' };
    case 'includes':
      return { field: expression.field, operator: 'includes', value: expression.option };
    case 'not': {
      const inner = expression.operand;
      if (inner.kind === 'answered') {
        return { field: inner.field, operator: 'is_not_answered' };
      }
      if (inner.kind === 'includes') {
        return { field: inner.field, operator: 'does_not_include', value: inner.option };
      }
      return undefined;
    }
    case 'any': {
      // The one compound shape a single clause produces: "is not checked".
      const [first, second] = expression.operands;
      if (
        expression.operands.length === 2 &&
        first?.kind === 'not' &&
        first.operand.kind === 'answered' &&
        second?.kind === 'compare' &&
        second.operator === 'eq' &&
        second.left.kind === 'answer' &&
        second.left.field === first.operand.field &&
        second.right.kind === 'boolean' &&
        !second.right.value
      ) {
        return { field: first.operand.field, operator: 'is_not_checked' };
      }
      return undefined;
    }
    case 'compare': {
      if (expression.left.kind === 'count') {
        const operator = COMPARISONS[expression.operator];
        return operator !== undefined && expression.right.kind === 'number'
          ? {
              field: expression.left.section,
              operator,
              value: expression.right.value,
              subject: 'entry_count',
            }
          : undefined;
      }
      if (expression.left.kind !== 'answer') {
        return undefined;
      }
      const target = field(expression.left.field);
      if (target === undefined) {
        return undefined;
      }
      const { right } = expression;
      const valueType = describeFieldType(target.type).valueType;
      const temporal = valueType === 'date' || valueType === 'time' || valueType === 'datetime';

      if (
        right.kind === 'boolean' &&
        valueType === 'boolean' &&
        expression.operator === 'eq' &&
        right.value
      ) {
        return { field: target.id, operator: 'is_checked' };
      }
      if (right.kind === 'today' && valueType === 'date') {
        if (expression.operator === 'lt') return { field: target.id, operator: 'is_before_today' };
        if (expression.operator === 'gt') return { field: target.id, operator: 'is_after_today' };
        return undefined;
      }
      let compared: { value: string } | { valueField: ElementId };
      if (right.kind === 'answer') {
        compared = { valueField: right.field };
      } else if (
        right.kind !== 'boolean' &&
        right.kind !== 'today' &&
        'value' in right &&
        typeof right.value === 'string' &&
        literal(target, right.value).kind === right.kind
      ) {
        compared = { value: right.value };
      } else {
        return undefined;
      }

      if (temporal) {
        const operator =
          expression.operator === 'eq'
            ? 'is'
            : expression.operator === 'lt'
              ? 'is_before'
              : expression.operator === 'gt'
                ? 'is_after'
                : undefined;
        return operator === undefined ? undefined : { field: target.id, operator, ...compared };
      }
      const operator = COMPARISONS[expression.operator];
      if (
        operator === undefined ||
        (valueType !== 'number' && operator !== 'is' && operator !== 'is_not')
      ) {
        return undefined;
      }
      return { field: target.id, operator, ...compared };
    }
    default:
      return undefined;
  }
}

/**
 * The clauses an expression was built from, or `undefined` if it cannot be
 * shown as clauses. `undefined` input — no condition — is an empty "all".
 */
export function fromExpression(
  expression: Expression | undefined,
  field: (id: ElementId) => Field | undefined,
): ConditionModel | undefined {
  if (expression === undefined) {
    return { match: 'all', clauses: [] };
  }

  const single = readClause(expression, field);
  if (single !== undefined) {
    return { match: 'all', clauses: [single] };
  }

  if (expression.kind === 'all' || expression.kind === 'any') {
    const clauses: ConditionClause[] = [];
    for (const operand of expression.operands) {
      const clause = readClause(operand, field);
      if (clause === undefined) {
        return undefined;
      }
      clauses.push(clause);
    }
    return { match: expression.kind, clauses };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Problems a clause can have while it is being built
// ---------------------------------------------------------------------------

export type ClauseProblem =
  | 'unknown_field'
  | 'operator_not_allowed'
  | 'value_required'
  | 'value_invalid'
  | 'unknown_option'
  | 'compared_field_unknown'
  | 'compared_field_mismatch';

/**
 * What is wrong with one clause, for the builder to show beside it.
 *
 * The compiler would catch every one of these at publish, but by then the
 * admin is looking at a list of paths. Here the problem sits next to the
 * dropdown that caused it.
 */
export function clauseProblem(
  clause: ConditionClause,
  field: (id: ElementId) => Field | undefined,
): ClauseProblem | undefined {
  if (clause.subject === 'entry_count') {
    if (!ENTRY_COUNT_OPERATORS.includes(clause.operator)) {
      return 'operator_not_allowed';
    }
    if ((clause.value ?? '') === '') {
      return 'value_required';
    }
    return /^(?:0|[1-9][0-9]{0,2})$/u.test(clause.value ?? '') ? undefined : 'value_invalid';
  }
  const target = field(clause.field);
  if (target === undefined) {
    return 'unknown_field';
  }
  if (!operatorsFor(target).includes(clause.operator)) {
    return 'operator_not_allowed';
  }
  if (!takesValue(clause.operator)) {
    return undefined;
  }

  if (clause.valueField !== undefined && FIELD_COMPARABLE.has(clause.operator)) {
    const other = field(clause.valueField);
    if (other === undefined) {
      return 'compared_field_unknown';
    }
    return describeFieldType(other.type).valueType === describeFieldType(target.type).valueType
      ? undefined
      : 'compared_field_mismatch';
  }

  const value = clause.value ?? '';
  if (value === '') {
    return 'value_required';
  }

  const offered = choiceValues(target);
  if (offered !== undefined) {
    return offered.includes(value) ? undefined : 'unknown_option';
  }

  switch (describeFieldType(target.type).valueType) {
    case 'number':
      return parseDecimal(value) === undefined ? 'value_invalid' : undefined;
    case 'date':
      return parseDate(value) === undefined ? 'value_invalid' : undefined;
    case 'time':
      return parseTime(value) === undefined ? 'value_invalid' : undefined;
    case 'datetime':
      return parseDatetime(value) === undefined ? 'value_invalid' : undefined;
    default:
      return undefined;
  }
}
