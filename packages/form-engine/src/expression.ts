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
  // Definitely true or false, never unknown: the one way to test for "left blank".
  | { kind: 'answered'; field: ElementId }
  // Whether a multi-select answer includes an option.
  | { kind: 'includes'; field: ElementId; option: string }
  | { kind: 'not'; operand: Expression }
  | { kind: 'all'; operands: Expression[] }
  | { kind: 'any'; operands: Expression[] }
  | { kind: 'compare'; operator: ComparisonOperator; left: Expression; right: Expression }
  | { kind: 'arithmetic'; operator: ArithmeticOperator; left: Expression; right: Expression };

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
    if (node.kind === 'answer' || node.kind === 'answered' || node.kind === 'includes') {
      if (!seen.includes(node.field)) {
        seen.push(node.field);
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
    default:
      return;
  }
}

/** Nodes and depth, so a definition cannot make evaluation arbitrarily expensive. */
export function measure(expression: Expression): { nodes: number; depth: number } {
  switch (expression.kind) {
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
    default:
      return { nodes: 1, depth: 1 };
  }
}
