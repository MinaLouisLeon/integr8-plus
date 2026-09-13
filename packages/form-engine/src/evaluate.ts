import type { CompiledForm } from './compile.js';
import {
  add,
  compareDecimal,
  type Decimal,
  divide,
  formatDecimal,
  fromInteger,
  MAX_SCALE,
  multiply,
  parseDecimal,
  rescale,
  subtract,
} from './decimal.js';
import type { ComparisonOperator, Expression } from './expression.js';
import { type Field, hasAnswerShape, isAnswered, isCalculated } from './field-types.js';
import type { ElementId } from './ids.js';
import { parseDate, parseDatetime, parseTime } from './temporal.js';

/**
 * Working out what a form looks like for a given set of answers.
 *
 * ## Unknown is a value
 *
 * A rule reading an unanswered field does not get `false`, `0` or `""`. It gets
 * *unknown*, and unknown propagates: `answer > 5` is unknown, `not unknown` is
 * unknown, `unknown and false` is false, `unknown or true` is true. That is
 * Kleene's three-valued logic, and it is the only reading under which "show
 * *Reason* when *Result* is not *Pass*" does not pop up the moment a blank form
 * opens.
 *
 * An element is visible only when its condition is **definitely true**. To act
 * on a blank answer, a rule says so with `answered`, which is never unknown.
 *
 * ## Hidden means absent
 *
 * The answer to a hidden field does not exist as far as any other rule is
 * concerned — even if the person typed it before the field disappeared. So
 * changing *Result* from *Fail* to *Pass* hides *Reason*, and everything that
 * depended on *Reason* reacts as though it were never filled. The typed value is
 * kept in state, so switching back restores it, but it is never submitted.
 *
 * ## Order
 *
 * The compiled form's evaluation order puts every dependency first, so one pass
 * is enough. There is no fixpoint iteration to converge in one runtime and
 * oscillate in another.
 */

export interface EvaluationContext {
  /** The date the form is being filled, `YYYY-MM-DD`, in the site's calendar. */
  today?: string;
}

export type Answers = Readonly<Record<string, unknown>>;

/** A value as a rule sees it. `undefined` is unknown. */
export type RuleValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: Decimal }
  | { type: 'boolean'; value: boolean }
  | { type: 'date' | 'time' | 'datetime'; value: number }
  | { type: 'options'; value: readonly string[] }
  | { type: 'opaque' };

export interface FormEvaluation {
  /** Every page, section and field id. */
  readonly visible: ReadonlyMap<ElementId, boolean>;
  /**
   * The effective answer to every visible field that has one: typed answers as
   * given, and calculated fields as computed. Hidden fields are absent.
   */
  readonly values: ReadonlyMap<ElementId, unknown>;
}

// ---------------------------------------------------------------------------
// Answers into rule values
// ---------------------------------------------------------------------------

/**
 * How a rule reads a stored answer. A malformed answer reads as unknown; it is
 * validation's job to say it is malformed, not a condition's to guess at it.
 */
export function toRuleValue(field: Field, answer: unknown): RuleValue | undefined {
  if (!isAnswered(field, answer) || !hasAnswerShape(field, answer)) {
    return undefined;
  }

  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'barcode':
    case 'dropdown':
    case 'radio':
    case 'yes_no':
      return { type: 'text', value: answer as string };
    case 'number':
    case 'rating':
      return { type: 'number', value: fromInteger(answer as number) };
    case 'decimal': {
      const parsed = parseDecimal(answer as string);
      return parsed === undefined ? undefined : { type: 'number', value: parsed };
    }
    case 'date':
      return temporal('date', parseDate(answer as string));
    case 'time':
      return temporal('time', parseTime(answer as string));
    case 'datetime':
      return temporal('datetime', parseDatetime(answer as string));
    case 'multi_select':
      return { type: 'options', value: answer as string[] };
    case 'checkbox':
      return { type: 'boolean', value: answer as boolean };
    case 'signature':
    case 'photo':
    case 'file':
    case 'gps':
      return { type: 'opaque' };
  }
}

function temporal(
  type: 'date' | 'time' | 'datetime',
  value: number | undefined,
): RuleValue | undefined {
  return value === undefined ? undefined : { type, value };
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export interface Scope {
  /** The effective value of a field: unknown if hidden or unanswered. */
  value(field: ElementId): RuleValue | undefined;
  context: EvaluationContext;
}

export function evaluateExpression(expression: Expression, scope: Scope): RuleValue | undefined {
  switch (expression.kind) {
    case 'text':
      return { type: 'text', value: expression.value };
    case 'boolean':
      return { type: 'boolean', value: expression.value };
    case 'number': {
      const parsed = parseDecimal(expression.value);
      return parsed === undefined ? undefined : { type: 'number', value: parsed };
    }
    case 'date':
      return temporal('date', parseDate(expression.value));
    case 'time':
      return temporal('time', parseTime(expression.value));
    case 'datetime':
      return temporal('datetime', parseDatetime(expression.value));
    case 'today':
      return scope.context.today === undefined
        ? undefined
        : temporal('date', parseDate(scope.context.today));
    case 'answer':
      return scope.value(expression.field);
    case 'answered':
      return { type: 'boolean', value: scope.value(expression.field) !== undefined };
    case 'includes': {
      const value = scope.value(expression.field);
      return value?.type === 'options'
        ? { type: 'boolean', value: value.value.includes(expression.option) }
        : undefined;
    }
    case 'not': {
      const operand = truth(evaluateExpression(expression.operand, scope));
      return operand === undefined ? undefined : { type: 'boolean', value: !operand };
    }
    case 'all':
    case 'any':
      return combine(expression, scope);
    case 'compare':
      return compare(
        expression.operator,
        evaluateExpression(expression.left, scope),
        evaluateExpression(expression.right, scope),
      );
    case 'arithmetic':
      return arithmetic(
        expression.operator,
        evaluateExpression(expression.left, scope),
        evaluateExpression(expression.right, scope),
      );
  }
}

/** `true`, `false`, or unknown. Anything that is not a boolean is unknown. */
export function truth(value: RuleValue | undefined): boolean | undefined {
  return value?.type === 'boolean' ? value.value : undefined;
}

function combine(
  expression: Extract<Expression, { kind: 'all' | 'any' }>,
  scope: Scope,
): RuleValue | undefined {
  // The value that decides the whole result on its own: one false settles
  // "all", one true settles "any", whatever else is unknown.
  const decisive = expression.kind === 'any';
  let unknown = false;

  for (const operand of expression.operands) {
    const value = truth(evaluateExpression(operand, scope));
    if (value === undefined) {
      unknown = true;
    } else if (value === decisive) {
      return { type: 'boolean', value: decisive };
    }
  }

  return unknown ? undefined : { type: 'boolean', value: !decisive };
}

function compare(
  operator: ComparisonOperator,
  left: RuleValue | undefined,
  right: RuleValue | undefined,
): RuleValue | undefined {
  if (left === undefined || left.type !== right?.type) {
    return undefined;
  }

  let order: number;
  switch (left.type) {
    case 'number':
      order = compareDecimal(left.value, (right as typeof left).value);
      break;
    case 'date':
    case 'time':
    case 'datetime':
      order = Math.sign(left.value - (right as typeof left).value);
      break;
    case 'text':
    case 'boolean':
      // Equality only; the compiler refuses ordering on these.
      order = left.value === (right as typeof left).value ? 0 : 1;
      break;
    /* v8 ignore next 2 -- the compiler refuses comparisons of these */
    default:
      return undefined;
  }

  const result =
    operator === 'eq'
      ? order === 0
      : operator === 'ne'
        ? order !== 0
        : operator === 'lt'
          ? order < 0
          : operator === 'le'
            ? order <= 0
            : operator === 'gt'
              ? order > 0
              : order >= 0;

  return { type: 'boolean', value: result };
}

function arithmetic(
  operator: Extract<Expression, { kind: 'arithmetic' }>['operator'],
  left: RuleValue | undefined,
  right: RuleValue | undefined,
): RuleValue | undefined {
  if (left?.type !== 'number' || right?.type !== 'number') {
    return undefined;
  }

  switch (operator) {
    case 'add':
      return { type: 'number', value: add(left.value, right.value) };
    case 'subtract':
      return { type: 'number', value: subtract(left.value, right.value) };
    case 'multiply': {
      // Products grow in scale; cap it so a chain of multiplications stays cheap.
      const product = multiply(left.value, right.value);
      return {
        type: 'number',
        value: product.scale > MAX_SCALE ? rescale(product, MAX_SCALE) : product,
      };
    }
    case 'divide': {
      const quotient = divide(left.value, right.value, MAX_SCALE);
      return quotient === undefined ? undefined : { type: 'number', value: quotient };
    }
  }
}

// ---------------------------------------------------------------------------
// The whole form
// ---------------------------------------------------------------------------

export function evaluateForm(
  form: CompiledForm,
  answers: Answers,
  context: EvaluationContext = {},
): FormEvaluation {
  const visible = new Map<ElementId, boolean>();
  const values = new Map<ElementId, unknown>();
  const ruleValues = new Map<ElementId, RuleValue>();

  const scope: Scope = {
    value: (field) => ruleValues.get(field),
    context,
  };

  for (const id of form.evaluationOrder) {
    const element = form.elements.get(id);
    /* v8 ignore next 3 -- the evaluation order is built from these elements */
    if (element === undefined) {
      continue;
    }

    const containerVisible =
      element.parent === undefined ? true : visible.get(element.parent) === true;
    const shown =
      containerVisible &&
      (element.visibleWhen === undefined ||
        truth(evaluateExpression(element.visibleWhen, scope)) === true);
    visible.set(id, shown);

    const field = element.field;
    if (field === undefined || !shown) {
      continue;
    }

    const stored = isCalculated(field) ? calculate(field, scope) : answerOf(field, answers);
    if (stored === undefined) {
      continue;
    }

    const ruleValue = toRuleValue(field, stored);
    if (ruleValue !== undefined) {
      values.set(id, stored);
      ruleValues.set(id, ruleValue);
    } else if (hasAnswerShape(field, stored) && isAnswered(field, stored)) {
      // Well-formed but unreadable by rules — a decimal typed as "1.2.3". It is
      // still the person's answer, and validation will say what is wrong with it.
      values.set(id, stored);
    }
  }

  return { visible, values };
}

/**
 * The answer stored under an id, and only an answer.
 *
 * `constructor` is a legal field id, and `answers.constructor` is a function on
 * every plain object. Reading answers any other way — `answers[id]`, `id in
 * answers` — finds it.
 */
export function ownAnswer(answers: Answers, id: ElementId): unknown {
  return Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : undefined;
}

function answerOf(field: Field, answers: Answers): unknown {
  return ownAnswer(answers, field.id);
}

/** The stored form of a calculated field: an integer for `number`, text for `decimal`. */
function calculate(field: Field, scope: Scope): unknown {
  if ((field.type !== 'number' && field.type !== 'decimal') || field.calculation === undefined) {
    return undefined;
  }

  const result = evaluateExpression(field.calculation, scope);
  if (result?.type !== 'number') {
    return undefined;
  }

  if (field.type === 'decimal') {
    return formatDecimal(rescale(result.value, field.decimalPlaces));
  }

  const whole = rescale(result.value, 0).units;
  // Past the safe range an integer stops being exact in JSON. No value is better
  // than a wrong one.
  const asNumber = Number(whole);
  return Number.isSafeInteger(asNumber) && BigInt(asNumber) === whole ? asNumber : undefined;
}
