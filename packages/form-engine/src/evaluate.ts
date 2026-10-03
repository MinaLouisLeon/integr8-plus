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
import { ENTRY_ID, type Entry, LIMITS } from './definition.js';
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
 *
 * ## Entries
 *
 * A field of a repeatable section is worked out once per entry, at its place in
 * the order, against a scope that reads that entry's answers first and the rest
 * of the form after. Across entries, `count` is never unknown (a hidden section
 * has none); `sum` adds the answers that are known, and is 0 over none; `min`
 * and `max` over no known answer are unknown; `some` and `every` are "any" and
 * "all" over the entries, with the same three-valued logic — so `every` over no
 * entries is true, and `some` is false.
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

/** One entry of a repeatable section, worked out. */
export interface EntryEvaluation {
  readonly id: string;
  /** Every field of the section, for this entry. */
  readonly visible: ReadonlyMap<ElementId, boolean>;
  /** This entry's effective answers, calculated ones included. Hidden fields are absent. */
  readonly values: ReadonlyMap<ElementId, unknown>;
}

export interface FormEvaluation {
  /** Every page, section and field id — except the fields of repeatable sections, which are per entry. */
  readonly visible: ReadonlyMap<ElementId, boolean>;
  /**
   * The effective answer to every visible field that has one: typed answers as
   * given, and calculated fields as computed. Hidden fields are absent. A
   * visible repeatable section with entries has its entries here, as stored:
   * `[{ id, values }]`, each with its effective answers.
   */
  readonly values: ReadonlyMap<ElementId, unknown>;
  /** Every repeatable section's entries, in order. A hidden section has none. */
  readonly entries: ReadonlyMap<ElementId, readonly EntryEvaluation[]>;
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
  /**
   * A repeatable section's entries, each as a scope that reads that entry's
   * answers and then this scope's. None while the section is hidden.
   */
  entries(section: ElementId): readonly Scope[];
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
    case 'count':
      return { type: 'number', value: fromInteger(scope.entries(expression.section).length) };
    case 'aggregate':
      return aggregate(expression, scope);
    case 'some':
    case 'every': {
      // "any" and "all" over the entries: one decisive entry settles it.
      const decisive = expression.kind === 'some';
      let unknown = false;
      for (const entry of scope.entries(expression.section)) {
        const value = truth(evaluateExpression(expression.condition, entry));
        if (value === undefined) {
          unknown = true;
        } else if (value === decisive) {
          return { type: 'boolean', value: decisive };
        }
      }
      return unknown ? undefined : { type: 'boolean', value: !decisive };
    }
  }
}

function aggregate(
  expression: Extract<Expression, { kind: 'aggregate' }>,
  scope: Scope,
): RuleValue | undefined {
  let result: Decimal | undefined = expression.operator === 'sum' ? fromInteger(0) : undefined;
  for (const entry of scope.entries(expression.section)) {
    const value = entry.value(expression.field);
    if (value?.type !== 'number') {
      continue;
    }
    if (result === undefined) {
      result = value.value;
    } else if (expression.operator === 'sum') {
      result = add(result, value.value);
    } else {
      const order = compareDecimal(value.value, result);
      if (expression.operator === 'min' ? order < 0 : order > 0) {
        result = value.value;
      }
    }
  }
  return result === undefined ? undefined : { type: 'number', value: result };
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

/** What a scope needs to read one set of answers: an entry's, or the form's own. */
interface Frame {
  readonly ruleValues: ReadonlyMap<ElementId, RuleValue>;
  /** For an entry: the fields of its section, read here before anywhere else. */
  readonly fields: ReadonlySet<ElementId> | undefined;
}

/**
 * A scope over the form's answers, or an entry's inside it. `entriesOf` gives
 * each repeatable section's entries as frames; an entry's scope is built on the
 * scope that asked for it, so a rule inside one entry can read across another
 * section and still see its own entry's answers.
 */
function scopeOver(
  frame: Frame,
  parent: Scope | undefined,
  entriesOf: (section: ElementId) => readonly Frame[],
  context: EvaluationContext,
): Scope {
  const scope: Scope = {
    value: (field) =>
      frame.fields === undefined || frame.fields.has(field)
        ? frame.ruleValues.get(field)
        : parent?.value(field),
    entries: (section) =>
      entriesOf(section).map((entry) => scopeOver(entry, scope, entriesOf, context)),
    context,
  };
  return scope;
}

/** The fields of each repeatable section, from the compiled form. */
function sectionFields(form: CompiledForm): Map<ElementId, Set<ElementId>> {
  const found = new Map<ElementId, Set<ElementId>>();
  for (const element of form.elements.values()) {
    if (element.entries !== undefined) {
      const fields = found.get(element.entries) ?? new Set<ElementId>();
      fields.add(element.id);
      found.set(element.entries, fields);
    }
  }
  return found;
}

/**
 * The entries stored for a section, as evaluation reads them: an array of
 * `{ id, values }` with distinct, well-formed ids. Anything else in the list is
 * not an entry, and is passed over — `validateSubmission` is what refuses it.
 */
export function storedEntries(answers: Answers, section: ElementId): Entry[] {
  const stored = ownAnswer(answers, section);
  if (!Array.isArray(stored)) {
    return [];
  }
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const candidate of stored.slice(0, LIMITS.entriesPerSection) as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      continue;
    }
    const { id, values } = candidate as { id?: unknown; values?: unknown };
    if (
      typeof id !== 'string' ||
      !ENTRY_ID.test(id) ||
      seen.has(id) ||
      typeof values !== 'object' ||
      values === null ||
      Array.isArray(values)
    ) {
      continue;
    }
    seen.add(id);
    entries.push({ id, values: values as Record<string, unknown> });
  }
  return entries;
}

interface WorkingEntry {
  readonly id: string;
  readonly answers: Answers;
  readonly visible: Map<ElementId, boolean>;
  readonly values: Map<ElementId, unknown>;
  readonly ruleValues: Map<ElementId, RuleValue>;
  readonly fields: ReadonlySet<ElementId>;
}

export function evaluateForm(
  form: CompiledForm,
  answers: Answers,
  context: EvaluationContext = {},
): FormEvaluation {
  const visible = new Map<ElementId, boolean>();
  const values = new Map<ElementId, unknown>();
  const ruleValues = new Map<ElementId, RuleValue>();
  const fieldsBySection = sectionFields(form);
  const working = new Map<ElementId, WorkingEntry[]>();

  const scope = scopeOver(
    { ruleValues, fields: undefined },
    undefined,
    (section) => working.get(section) ?? [],
    context,
  );
  const entryScope = (entry: WorkingEntry) =>
    scopeOver(entry, scope, (section) => working.get(section) ?? [], context);

  /** Works out one field against one set of answers. */
  const settle = (
    field: Field,
    within: Scope,
    stored: Answers,
    into: { values: Map<ElementId, unknown>; ruleValues: Map<ElementId, RuleValue> },
  ) => {
    const value = isCalculated(field) ? calculate(field, within) : answerOf(field, stored);
    if (value === undefined) {
      return;
    }
    const ruleValue = toRuleValue(field, value);
    if (ruleValue !== undefined) {
      into.values.set(field.id, value);
      into.ruleValues.set(field.id, ruleValue);
    } else if (hasAnswerShape(field, value) && isAnswered(field, value)) {
      // Well-formed but unreadable by rules — a decimal typed as "1.2.3". It is
      // still the person's answer, and validation will say what is wrong with it.
      into.values.set(field.id, value);
    }
  };

  for (const id of form.evaluationOrder) {
    const element = form.elements.get(id);
    /* v8 ignore next 3 -- the evaluation order is built from these elements */
    if (element === undefined) {
      continue;
    }

    if (element.entries !== undefined) {
      // A field of a repeatable section: once per entry, each in its own scope.
      const sectionShown = visible.get(element.entries) === true;
      for (const entry of working.get(element.entries) ?? []) {
        const within = entryScope(entry);
        const shown =
          sectionShown &&
          (element.visibleWhen === undefined ||
            truth(evaluateExpression(element.visibleWhen, within)) === true);
        entry.visible.set(id, shown);
        if (shown && element.field !== undefined) {
          settle(element.field, within, entry.answers, entry);
        }
      }
      continue;
    }

    const containerVisible =
      element.parent === undefined ? true : visible.get(element.parent) === true;
    const shown =
      containerVisible &&
      (element.visibleWhen === undefined ||
        truth(evaluateExpression(element.visibleWhen, scope)) === true);
    visible.set(id, shown);

    if (element.repeat !== undefined) {
      // Hidden means absent: a hidden section has no entries for anything to read.
      const fields = fieldsBySection.get(id) ?? new Set<ElementId>();
      working.set(
        id,
        shown
          ? storedEntries(answers, id).map((entry) => ({
              id: entry.id,
              answers: entry.values,
              visible: new Map(),
              values: new Map(),
              ruleValues: new Map(),
              fields,
            }))
          : [],
      );
      continue;
    }

    const field = element.field;
    if (field === undefined || !shown) {
      continue;
    }
    settle(field, scope, answers, { values, ruleValues });
  }

  const entries = new Map<ElementId, EntryEvaluation[]>();
  for (const element of form.elements.values()) {
    if (element.repeat === undefined) {
      continue;
    }
    const worked = working.get(element.id) ?? [];
    entries.set(
      element.id,
      worked.map((entry) => ({ id: entry.id, visible: entry.visible, values: entry.values })),
    );
    if (worked.length > 0) {
      const inSection = fieldsBySection.get(element.id);
      const order = form.fields.filter((field) => inSection?.has(field.id) === true);
      values.set(
        element.id,
        worked.map((entry) => ({
          id: entry.id,
          values: Object.fromEntries(
            order.flatMap((field) =>
              entry.values.has(field.id) ? [[field.id, entry.values.get(field.id)]] : [],
            ),
          ),
        })),
      );
    }
  }

  return { visible, values, entries };
}

/**
 * A scope over an evaluation already made: what validation and anyone else
 * reading a finished evaluation use to evaluate a rule against it.
 */
export function evaluationScope(
  form: CompiledForm,
  evaluation: FormEvaluation,
  context: EvaluationContext = {},
): Scope {
  const readable = (values: ReadonlyMap<ElementId, unknown>) => {
    const ruleValues = new Map<ElementId, RuleValue>();
    for (const [id, value] of values) {
      const field = form.elements.get(id)?.field;
      const ruleValue = field === undefined ? undefined : toRuleValue(field, value);
      if (ruleValue !== undefined) {
        ruleValues.set(id, ruleValue);
      }
    }
    return ruleValues;
  };
  const fieldsBySection = sectionFields(form);
  const frames = new Map<ElementId, Frame[]>();
  for (const [section, entries] of evaluation.entries) {
    const fields = fieldsBySection.get(section) ?? new Set<ElementId>();
    frames.set(
      section,
      entries.map((entry) => ({ ruleValues: readable(entry.values), fields })),
    );
  }
  return scopeOver(
    { ruleValues: readable(evaluation.values), fields: undefined },
    undefined,
    (section) => frames.get(section) ?? [],
    context,
  );
}

/** The scope of one entry of an evaluation, over the form's own. */
export function entryScopeOf(
  form: CompiledForm,
  evaluation: FormEvaluation,
  section: ElementId,
  entryId: string,
  context: EvaluationContext = {},
): Scope | undefined {
  const top = evaluationScope(form, evaluation, context);
  const index = evaluation.entries.get(section)?.findIndex((entry) => entry.id === entryId) ?? -1;
  return index === -1 ? undefined : top.entries(section)[index];
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
