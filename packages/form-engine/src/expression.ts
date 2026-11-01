import { z } from 'zod';
import { type ElementId, elementIdSchema } from './ids.js';

/**
 * Rules as data: a small typed syntax tree, never a string of code.
 *
 * "Show *Reason for failure* when *Result* is *Fail*" is stored as
 *
 *   { kind: 'compare', operator: 'eq',
 *     left: { kind: 'answer', field: 'result' },
 *     right: { kind: 'text', value: 'fail' } }
 *
 * Why a tree rather than JSONLogic, which the plan also allows: every node here
 * has one meaning and a type the compiler can check before a form is published.
 * JSONLogic's operators coerce loosely (`"1" == 1`), which is exactly the kind
 * of rule that evaluates one way on the phone and another in a reviewer's head.
 * And P07's plain-language builder has to turn a tree back into a sentence; a
 * closed set of node kinds is what makes that possible.
 *
 * Nothing in this package ever calls `eval` or `new Function`, and the lint
 * config makes that an error rather than a promise.
 */

export const COMPARISON_OPERATORS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export const ARITHMETIC_OPERATORS = ['add', 'subtract', 'multiply', 'divide'] as const;
export type ArithmeticOperator = (typeof ARITHMETIC_OPERATORS)[number];

export const AGGREGATE_OPERATORS = ['sum', 'min', 'max'] as const;
export type AggregateOperator = (typeof AGGREGATE_OPERATORS)[number];

/** The least, greatest or average of several numbers in one row: `min(a, b, c)`. */
export const STATISTIC_OPERATORS = ['min', 'max', 'average'] as const;
export type StatisticOperator = (typeof STATISTIC_OPERATORS)[number];

/** What a difference between two dates or times is counted in. */
export const DURATION_UNITS = ['minutes', 'hours', 'days'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** What a date is moved by. A month keeps the day of the month where it can. */
export const DATE_STEP_UNITS = ['days', 'weeks', 'months'] as const;
export type DateStepUnit = (typeof DATE_STEP_UNITS)[number];

export const DATE_SHIFT_OPERATORS = ['add', 'subtract'] as const;
export type DateShiftOperator = (typeof DATE_SHIFT_OPERATORS)[number];

/** The most places a calculation may round to: the most a decimal question keeps. */
export const MAX_ROUND_PLACES = 6;

/** The most numbers one `min`, `max` or `average` may take. */
export const MAX_STATISTIC_OPERANDS = 20;

export type Expression =
  // Literals. Numbers are decimal text, never doubles — see decimal.ts.
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'time'; value: string }
  | { kind: 'datetime'; value: string }
  // The current answer to a field, or nothing if it is unanswered or hidden.
  | { kind: 'answer'; field: ElementId }
  // The date the form is being filled, supplied by the caller. Never a clock read.
  | { kind: 'today' }
  // The moment the form is being filled, supplied by the caller like `today`
  // (schema version 2). A date and time, so it is compared and subtracted
  // only with dates and times.
  | { kind: 'now' }
  // Definitely true or false, never unknown: the one way to test for "left blank".
  | { kind: 'answered'; field: ElementId }
  // Whether a multi-select answer includes an option.
  | { kind: 'includes'; field: ElementId; option: string }
  | { kind: 'not'; operand: Expression }
  | { kind: 'all'; operands: Expression[] }
  | { kind: 'any'; operands: Expression[] }
  | { kind: 'compare'; operator: ComparisonOperator; left: Expression; right: Expression }
  | { kind: 'arithmetic'; operator: ArithmeticOperator; left: Expression; right: Expression }
  // Schema version 2: number extras and date arithmetic (see `evaluate.ts`).
  // A number rounded half away from zero to `places` decimal places.
  | { kind: 'round'; operand: Expression; places: number }
  // `part` as a percentage of `whole`: part ÷ whole × 100.
  | { kind: 'percentage'; part: Expression; whole: Expression }
  // The least, greatest or average of the numbers among `operands` that are known.
  | { kind: 'statistic'; operator: StatisticOperator; operands: Expression[] }
  // `to` minus `from`, two dates, two times or two dates-and-times, in `unit`.
  | { kind: 'difference'; unit: DurationUnit; from: Expression; to: Expression }
  // A date moved forward or back by a whole number of days, weeks or months.
  | {
      kind: 'shift_date';
      operator: DateShiftOperator;
      unit: DateStepUnit;
      date: Expression;
      amount: Expression;
    }
  // Across the entries of a repeatable section (P13b). Inside `some` and
  // `every`, `condition` reads each entry's own answers in turn.
  // How many entries there are: never unknown, and 0 while the section is hidden.
  | { kind: 'count'; section: ElementId }
  // The sum, least or greatest answer to a number field across the entries.
  | { kind: 'aggregate'; operator: AggregateOperator; section: ElementId; field: ElementId }
  // Whether the condition holds for at least one entry, or for every entry.
  | { kind: 'some'; section: ElementId; condition: Expression }
  | { kind: 'every'; section: ElementId; condition: Expression };

export const expressionSchema: z.ZodType<Expression> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), value: z.string().max(2_000) }),
    z.strictObject({ kind: z.literal('number'), value: z.string().max(64) }),
    z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('date'), value: z.string().max(32) }),
    z.strictObject({ kind: z.literal('time'), value: z.string().max(32) }),
    z.strictObject({ kind: z.literal('datetime'), value: z.string().max(32) }),
    z.strictObject({ kind: z.literal('answer'), field: elementIdSchema }),
    z.strictObject({ kind: z.literal('today') }),
    z.strictObject({ kind: z.literal('now') }),
    z.strictObject({ kind: z.literal('answered'), field: elementIdSchema }),
    z.strictObject({
      kind: z.literal('includes'),
      field: elementIdSchema,
      option: z.string().min(1).max(200),
    }),
    z.strictObject({ kind: z.literal('not'), operand: expressionSchema }),
    z.strictObject({ kind: z.literal('all'), operands: z.array(expressionSchema).min(1).max(100) }),
    z.strictObject({ kind: z.literal('any'), operands: z.array(expressionSchema).min(1).max(100) }),
    z.strictObject({
      kind: z.literal('compare'),
      operator: z.enum(COMPARISON_OPERATORS),
      left: expressionSchema,
      right: expressionSchema,
    }),
    z.strictObject({
      kind: z.literal('arithmetic'),
      operator: z.enum(ARITHMETIC_OPERATORS),
      left: expressionSchema,
      right: expressionSchema,
    }),
    z.strictObject({
      kind: z.literal('round'),
      operand: expressionSchema,
      places: z.number().int().min(0).max(MAX_ROUND_PLACES),
    }),
    z.strictObject({
      kind: z.literal('percentage'),
      part: expressionSchema,
      whole: expressionSchema,
    }),
    z.strictObject({
      kind: z.literal('statistic'),
      operator: z.enum(STATISTIC_OPERATORS),
      operands: z.array(expressionSchema).min(1).max(MAX_STATISTIC_OPERANDS),
    }),
    z.strictObject({
      kind: z.literal('difference'),
      unit: z.enum(DURATION_UNITS),
      from: expressionSchema,
      to: expressionSchema,
    }),
    z.strictObject({
      kind: z.literal('shift_date'),
      operator: z.enum(DATE_SHIFT_OPERATORS),
      unit: z.enum(DATE_STEP_UNITS),
      date: expressionSchema,
      amount: expressionSchema,
    }),
    z.strictObject({ kind: z.literal('count'), section: elementIdSchema }),
    z.strictObject({
      kind: z.literal('aggregate'),
      operator: z.enum(AGGREGATE_OPERATORS),
      section: elementIdSchema,
      field: elementIdSchema,
    }),
    z.strictObject({
      kind: z.literal('some'),
      section: elementIdSchema,
      condition: expressionSchema,
    }),
    z.strictObject({
      kind: z.literal('every'),
      section: elementIdSchema,
      condition: expressionSchema,
    }),
  ]),
);

/**
 * Every field an expression reads, in first-appearance order.
 *
 * This is what the dependency graph is built from, so it has to find a
 * reference wherever one can hide.
 */
export function referencedFields(expression: Expression): ElementId[] {
  const seen: ElementId[] = [];
  visit(expression, (node) => {
    if (
      node.kind === 'answer' ||
      node.kind === 'answered' ||
      node.kind === 'includes' ||
      node.kind === 'aggregate'
    ) {
      if (!seen.includes(node.field)) {
        seen.push(node.field);
      }
    }
  });
  return seen;
}

/** Every repeatable section an expression reads across, in first-appearance order. */
export function referencedSections(expression: Expression): ElementId[] {
  const seen: ElementId[] = [];
  visit(expression, (node) => {
    if (
      node.kind === 'count' ||
      node.kind === 'aggregate' ||
      node.kind === 'some' ||
      node.kind === 'every'
    ) {
      if (!seen.includes(node.section)) {
        seen.push(node.section);
      }
    }
  });
  return seen;
}

/** Depth-first, parents before children. */
export function visit(expression: Expression, callback: (node: Expression) => void): void {
  callback(expression);
  switch (expression.kind) {
    case 'not':
      visit(expression.operand, callback);
      return;
    case 'all':
    case 'any':
      for (const operand of expression.operands) {
        visit(operand, callback);
      }
      return;
    case 'compare':
    case 'arithmetic':
      visit(expression.left, callback);
      visit(expression.right, callback);
      return;
    case 'round':
      visit(expression.operand, callback);
      return;
    case 'percentage':
      visit(expression.part, callback);
      visit(expression.whole, callback);
      return;
    case 'statistic':
      for (const operand of expression.operands) {
        visit(operand, callback);
      }
      return;
    case 'difference':
      visit(expression.from, callback);
      visit(expression.to, callback);
      return;
    case 'shift_date':
      visit(expression.date, callback);
      visit(expression.amount, callback);
      return;
    case 'some':
    case 'every':
      visit(expression.condition, callback);
      return;
    default:
      return;
  }
}

/** The expressions directly under a node, in order. */
export function children(expression: Expression): Expression[] {
  switch (expression.kind) {
    case 'not':
      return [expression.operand];
    case 'all':
    case 'any':
    case 'statistic':
      return expression.operands;
    case 'compare':
    case 'arithmetic':
      return [expression.left, expression.right];
    case 'round':
      return [expression.operand];
    case 'percentage':
      return [expression.part, expression.whole];
    case 'difference':
      return [expression.from, expression.to];
    case 'shift_date':
      return [expression.date, expression.amount];
    case 'some':
    case 'every':
      return [expression.condition];
    default:
      return [];
  }
}

/**
 * The node kinds schema version 2 added. A definition using any of them needs
 * an engine from 1.3.0 or later, so it declares `schemaVersion: 2`.
 */
export const VERSION_2_EXPRESSION_KINDS: ReadonlySet<Expression['kind']> = new Set([
  'now',
  'round',
  'percentage',
  'statistic',
  'difference',
  'shift_date',
]);

/** Nodes and depth, so a definition cannot make evaluation arbitrarily expensive. */
export function measure(expression: Expression): { nodes: number; depth: number } {
  switch (expression.kind) {
    case 'round':
    case 'percentage':
    case 'statistic':
    case 'difference':
    case 'shift_date': {
      let nodes = 1;
      let depth = 0;
      for (const child of children(expression)) {
        const inner = measure(child);
        nodes += inner.nodes;
        depth = Math.max(depth, inner.depth);
      }
      return { nodes, depth: depth + 1 };
    }
    case 'not': {
      const inner = measure(expression.operand);
      return { nodes: inner.nodes + 1, depth: inner.depth + 1 };
    }
    case 'all':
    case 'any': {
      let nodes = 1;
      let depth = 0;
      for (const operand of expression.operands) {
        const inner = measure(operand);
        nodes += inner.nodes;
        depth = Math.max(depth, inner.depth);
      }
      return { nodes, depth: depth + 1 };
    }
    case 'compare':
    case 'arithmetic': {
      const left = measure(expression.left);
      const right = measure(expression.right);
      return {
        nodes: left.nodes + right.nodes + 1,
        depth: Math.max(left.depth, right.depth) + 1,
      };
    }
    case 'some':
    case 'every': {
      const inner = measure(expression.condition);
      return { nodes: inner.nodes + 1, depth: inner.depth + 1 };
    }
    default:
      return { nodes: 1, depth: 1 };
  }
}
