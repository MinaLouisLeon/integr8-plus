import type { ArithmeticOperator, Expression } from '@integr8/form-engine';

/**
 * Calculations as a person writes them: "Hours × Rate + Call-out fee".
 *
 * A chain of terms, each a field or a number, joined by operators and worked
 * out left to right — the way a calculator does it, and the way somebody reads
 * the sentence aloud. That is narrower than what the engine can evaluate, on
 * purpose: only what can be shown as a chain can be edited as one, and anything
 * else (written by hand, or by P30's AI) is shown read-only rather than
 * mangled.
 */

export type Term = { kind: 'field'; field: string } | { kind: 'number'; value: string };

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
    default:
      return undefined;
  }
}

function termExpression(term: Term): Expression {
  return term.kind === 'field'
    ? { kind: 'answer', field: term.field }
    : { kind: 'number', value: term.value };
}
