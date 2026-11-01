import {
  type DateStepUnit,
  type DurationUnit,
  describeFieldType,
  type Expression,
  type Field,
  type FormDefinition,
  isQuestion,
  MAX_ROUND_PLACES,
  MAX_STATISTIC_OPERANDS,
  parseDate,
  parseDatetime,
  parseTime,
  type Section,
} from '@integr8/form-engine';
import { repeatableSections, repeatingScope } from './subjects';
import { say } from './text';

/**
 * Calculations as a typed formula (schema version 2): "([Hours] + [Travel]) ×
 * [Rate]", "round([Total] * 1.14, 2)", "add_months([Serviced on], 12)".
 *
 * Why a formula rather than the chain of steps the builder had before: brackets
 * and functions nest, and a nested thing built from dropdowns is a tree of
 * boxes nobody can read back. A line of text is what a spreadsheet taught
 * every office to read, and it stays readable when it grows. The editor makes
 * it hard to get wrong: questions come from a list as you type `[`, the
 * functions are buttons, and every keystroke is checked here — unknown names,
 * wrong arguments, a date where a number goes — with the result's kind shown.
 *
 * - **Questions** are `[Their wording]` in the language being edited, or
 *   `[their_key]` when two questions share a wording.
 * - **Numbers** are plain decimals; Arabic-Indic digits are read too.
 * - **Operators** `+ - * /` (also `× ÷` and `−`), with the usual order —
 *   multiplying and dividing before adding and subtracting — and brackets.
 * - **Functions** are in English in both languages, like a spreadsheet's:
 *   see {@link FUNCTIONS}.
 * - **Dates and times** written in quotes: `"2026-01-31"`, `"08:30"`.
 *
 * Every formula prints back to the same tree it parsed from, so a calculation
 * written with the old chain editor — worked out left to right — opens here
 * with the brackets that keep it meaning exactly what it meant.
 */

export type FormulaType = 'number' | 'date' | 'time' | 'datetime';

/** Every function, with what it takes, for the editor's buttons and its checks. */
export const FUNCTIONS = [
  'round',
  'percent',
  'min',
  'max',
  'average',
  'days',
  'hours',
  'minutes',
  'add_days',
  'add_weeks',
  'add_months',
  'subtract_days',
  'subtract_weeks',
  'subtract_months',
  'count',
  'sum',
  'today',
  'now',
] as const;
export type FormulaFunction = (typeof FUNCTIONS)[number];

/** What a function call looks like when the editor inserts it. */
export const FUNCTION_TEMPLATES: Readonly<Record<FormulaFunction, string>> = {
  round: 'round(, 2)',
  percent: 'percent(, )',
  min: 'min(, )',
  max: 'max(, )',
  average: 'average(, )',
  days: 'days(, )',
  hours: 'hours(, )',
  minutes: 'minutes(, )',
  add_days: 'add_days(, 1)',
  add_weeks: 'add_weeks(, 1)',
  add_months: 'add_months(, 1)',
  subtract_days: 'subtract_days(, 1)',
  subtract_weeks: 'subtract_weeks(, 1)',
  subtract_months: 'subtract_months(, 1)',
  count: 'count()',
  sum: 'sum(, )',
  today: 'today',
  now: 'now',
};

export type FormulaProblem =
  | { code: 'empty' }
  | { code: 'syntax'; at: number; found: string }
  | { code: 'unclosed_reference'; at: number }
  | { code: 'unknown_name'; name: string }
  | { code: 'ambiguous_name'; name: string }
  | { code: 'unknown_function'; name: string }
  | { code: 'arguments'; name: string }
  | { code: 'places'; maximum: number }
  | { code: 'not_a_section'; name: string }
  | { code: 'not_in_section'; name: string; section: string }
  | { code: 'number_text'; text: string }
  | { code: 'literal'; text: string }
  | { code: 'needs'; expected: FormulaType | 'number_or_moment'; found: FormulaType }
  | { code: 'mixed'; left: FormulaType; right: FormulaType }
  | { code: 'time_in_days' }
  | { code: 'result'; expected: FormulaType; found: FormulaType };

export type FormulaResult =
  { ok: true; expression: Expression; type: FormulaType } | { ok: false; problem: FormulaProblem };

/** What a formula on one question may read, where that question sits. */
export interface FormulaSources {
  /** Questions read with one answer: numbers, dates and times outside repeatable sections, and the own entry's. */
  questions: Field[];
  /** Repeatable sections read across, each with its number questions. */
  sections: { section: Section; numbers: Field[] }[];
}

const READABLE: ReadonlySet<string> = new Set(['number', 'date', 'time', 'datetime']);

export function formulaSources(definition: FormDefinition, fieldId: string): FormulaSources {
  const scope = repeatingScope(definition, fieldId);
  const readable = (field: Field) =>
    field.id !== fieldId && READABLE.has(describeFieldType(field.type).valueType);
  const questions = definition.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.repeat === undefined || section.id === scope?.id
        ? section.fields.filter(isQuestion).filter(readable)
        : [],
    ),
  );
  const sections = repeatableSections(definition)
    .filter((section) => section.id !== scope?.id)
    .map((section) => ({
      section,
      numbers: section.fields
        .filter(isQuestion)
        .filter((field) => describeFieldType(field.type).valueType === 'number'),
    }));
  return { questions, sections };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A problem found while reading, carried out of the recursion. */
class FormulaFailure extends Error {
  readonly problem: FormulaProblem;
  constructor(problem: FormulaProblem) {
    super(problem.code);
    this.problem = problem;
  }
}

type Token =
  | { kind: 'number'; text: string; at: number }
  | { kind: 'string'; text: string; at: number }
  | { kind: 'reference'; text: string; at: number }
  | { kind: 'name'; text: string; at: number }
  | { kind: 'symbol'; text: string; at: number }
  | { kind: 'end'; at: number };

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Western digits, `.` for the Arabic decimal mark, and the operators as typed on any keyboard. */
function normalise(text: string): string {
  let out = '';
  for (const character of text) {
    const arabic = ARABIC_DIGITS.indexOf(character);
    const persian = PERSIAN_DIGITS.indexOf(character);
    out +=
      arabic !== -1
        ? String(arabic)
        : persian !== -1
          ? String(persian)
          : character === '٫'
            ? '.'
            : character === '،' || character === '؛'
              ? ','
              : character === '×'
                ? '*'
                : character === '÷'
                  ? '/'
                  : character === '−'
                    ? '-'
                    : character;
  }
  return out;
}

function tokenize(source: string): Token[] | FormulaProblem {
  const text = normalise(source);
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const character = text[at]!;
    if (/\s/u.test(character)) {
      at += 1;
      continue;
    }
    if (character === '[') {
      const close = text.indexOf(']', at + 1);
      if (close === -1) {
        return { code: 'unclosed_reference', at };
      }
      tokens.push({ kind: 'reference', text: text.slice(at + 1, close).trim(), at });
      at = close + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const close = text.indexOf(character, at + 1);
      if (close === -1) {
        return { code: 'syntax', at, found: character };
      }
      tokens.push({ kind: 'string', text: text.slice(at + 1, close).trim(), at });
      at = close + 1;
      continue;
    }
    const number = /^[0-9]+(?:\.[0-9]+)?/u.exec(text.slice(at));
    if (number !== null) {
      tokens.push({ kind: 'number', text: number[0], at });
      at += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(at));
    if (name !== null) {
      tokens.push({ kind: 'name', text: name[0].toLowerCase(), at });
      at += name[0].length;
      continue;
    }
    if ('+-*/(),'.includes(character)) {
      tokens.push({ kind: 'symbol', text: character, at });
      at += 1;
      continue;
    }
    return { code: 'syntax', at, found: character };
  }
  tokens.push({ kind: 'end', at });
  return tokens;
}

/** The parse tree, before names are looked up. */
type Node =
  | { kind: 'number'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'reference'; text: string }
  | { kind: 'negate'; operand: Node }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[]; bare: boolean };

class Parser {
  #index = 0;
  readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  get #token(): Token {
    return this.tokens[this.#index]!;
  }

  #fail(): never {
    const token = this.#token;
    throw new FormulaFailure({
      code: 'syntax',
      at: token.at,
      found: token.kind === 'end' ? '' : 'text' in token ? token.text : '',
    });
  }

  #symbol(text: string): boolean {
    const token = this.#token;
    if (token.kind === 'symbol' && token.text === text) {
      this.#index += 1;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.#sum();
    if (this.#token.kind !== 'end') {
      this.#fail();
    }
    return node;
  }

  #sum(): Node {
    let left = this.#product();
    for (;;) {
      if (this.#symbol('+')) {
        left = { kind: 'binary', operator: '+', left, right: this.#product() };
      } else if (this.#symbol('-')) {
        left = { kind: 'binary', operator: '-', left, right: this.#product() };
      } else {
        return left;
      }
    }
  }

  #product(): Node {
    let left = this.#unary();
    for (;;) {
      if (this.#symbol('*')) {
        left = { kind: 'binary', operator: '*', left, right: this.#unary() };
      } else if (this.#symbol('/')) {
        left = { kind: 'binary', operator: '/', left, right: this.#unary() };
      } else {
        return left;
      }
    }
  }

  #unary(): Node {
    if (this.#symbol('-')) {
      return { kind: 'negate', operand: this.#unary() };
    }
    return this.#primary();
  }

  #primary(): Node {
    const token = this.#token;
    switch (token.kind) {
      case 'number':
      case 'string':
      case 'reference':
        this.#index += 1;
        return { kind: token.kind, text: token.text };
      case 'name': {
        this.#index += 1;
        if (!this.#symbol('(')) {
          return { kind: 'call', name: token.text, args: [], bare: true };
        }
        const args: Node[] = [];
        if (!this.#symbol(')')) {
          do {
            args.push(this.#sum());
          } while (this.#symbol(','));
          if (!this.#symbol(')')) {
            this.#fail();
          }
        }
        return { kind: 'call', name: token.text, args, bare: false };
      }
      case 'symbol':
        if (this.#symbol('(')) {
          const inner = this.#sum();
          if (!this.#symbol(')')) {
            this.#fail();
          }
          return inner;
        }
        return this.#fail();
      case 'end':
        return this.#fail();
    }
  }
}

/** Plain decimal text the engine reads, from what was typed: no leading zeros. */
function decimalText(text: string, negative: boolean): string {
  const [whole = '0', fraction] = text.split('.');
  const trimmed = whole.replace(/^0+(?=\d)/u, '');
  const value = fraction === undefined ? trimmed : `${trimmed}.${fraction}`;
  return negative && /[1-9]/u.test(value) ? `-${value}` : value;
}

const STEP: Readonly<Record<string, { operator: 'add' | 'subtract'; unit: DateStepUnit }>> = {
  add_days: { operator: 'add', unit: 'days' },
  add_weeks: { operator: 'add', unit: 'weeks' },
  add_months: { operator: 'add', unit: 'months' },
  subtract_days: { operator: 'subtract', unit: 'days' },
  subtract_weeks: { operator: 'subtract', unit: 'weeks' },
  subtract_months: { operator: 'subtract', unit: 'months' },
};

const DURATION: ReadonlySet<string> = new Set(['days', 'hours', 'minutes']);

class Resolver {
  readonly sources: FormulaSources;
  readonly locale: string;
  constructor(sources: FormulaSources, locale: string) {
    this.sources = sources;
    this.locale = locale;
  }

  #question(name: string): Field {
    const byWording = this.sources.questions.filter(
      (field) => say(field.label, this.locale).trim() === name,
    );
    if (byWording.length === 1) {
      return byWording[0]!;
    }
    const byKey = this.sources.questions.find((field) => field.id === name);
    if (byKey !== undefined) {
      return byKey;
    }
    throw new FormulaFailure(
      byWording.length > 1 ? { code: 'ambiguous_name', name } : { code: 'unknown_name', name },
    );
  }

  #section(node: Node): { section: Section; numbers: Field[] } {
    const name = node.kind === 'reference' ? node.text : '';
    const found = this.sources.sections.find(
      (candidate) =>
        sectionName(candidate.section, this.locale) === name || candidate.section.id === name,
    );
    if (found === undefined) {
      throw new FormulaFailure({ code: 'not_a_section', name });
    }
    return found;
  }

  #isSection(node: Node | undefined): boolean {
    return (
      node?.kind === 'reference' &&
      this.sources.sections.some(
        (candidate) =>
          sectionName(candidate.section, this.locale) === node.text ||
          candidate.section.id === node.text,
      ) &&
      !this.sources.questions.some(
        (field) => say(field.label, this.locale).trim() === node.text || field.id === node.text,
      )
    );
  }

  resolve(node: Node): { expression: Expression; type: FormulaType } {
    switch (node.kind) {
      case 'number':
        return {
          expression: { kind: 'number', value: decimalText(node.text, false) },
          type: 'number',
        };
      case 'string':
        return literal(node.text);
      case 'reference': {
        const field = this.#question(node.text);
        return {
          expression: { kind: 'answer', field: field.id },
          type: describeFieldType(field.type).valueType as FormulaType,
        };
      }
      case 'negate': {
        if (node.operand.kind === 'number') {
          return {
            expression: { kind: 'number', value: decimalText(node.operand.text, true) },
            type: 'number',
          };
        }
        const operand = this.#number(node.operand);
        return {
          expression: {
            kind: 'arithmetic',
            operator: 'subtract',
            left: { kind: 'number', value: '0' },
            right: operand,
          },
          type: 'number',
        };
      }
      case 'binary':
        return {
          expression: {
            kind: 'arithmetic',
            operator: ({ '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide' } as const)[
              node.operator
            ],
            left: this.#number(node.left),
            right: this.#number(node.right),
          },
          type: 'number',
        };
      case 'call':
        return this.#call(node);
    }
  }

  #typed(node: Node, expected: FormulaType): Expression {
    const { expression, type } = this.resolve(node);
    if (type !== expected) {
      throw new FormulaFailure({ code: 'needs', expected, found: type });
    }
    return expression;
  }

  #number(node: Node): Expression {
    return this.#typed(node, 'number');
  }

  #arity(node: Extract<Node, { kind: 'call' }>, count: number | [number, number]): void {
    const [least, most] = typeof count === 'number' ? [count, count] : count;
    if (node.args.length < least || node.args.length > most) {
      throw new FormulaFailure({ code: 'arguments', name: node.name });
    }
  }

  #call(node: Extract<Node, { kind: 'call' }>): { expression: Expression; type: FormulaType } {
    const name = node.name;
    if (name === 'today' || name === 'now') {
      this.#arity(node, 0);
      return name === 'today'
        ? { expression: { kind: 'today' }, type: 'date' }
        : { expression: { kind: 'now' }, type: 'datetime' };
    }
    if (node.bare) {
      throw new FormulaFailure(
        (FUNCTIONS as readonly string[]).includes(name)
          ? { code: 'arguments', name }
          : { code: 'unknown_function', name },
      );
    }
    switch (name) {
      case 'round': {
        this.#arity(node, 2);
        const places = node.args[1]!;
        const count = places.kind === 'number' ? Number(places.text) : Number.NaN;
        if (!Number.isInteger(count) || count < 0 || count > MAX_ROUND_PLACES) {
          throw new FormulaFailure({ code: 'places', maximum: MAX_ROUND_PLACES });
        }
        return {
          expression: { kind: 'round', operand: this.#number(node.args[0]!), places: count },
          type: 'number',
        };
      }
      case 'percent':
        this.#arity(node, 2);
        return {
          expression: {
            kind: 'percentage',
            part: this.#number(node.args[0]!),
            whole: this.#number(node.args[1]!),
          },
          type: 'number',
        };
      case 'count': {
        this.#arity(node, 1);
        const { section } = this.#section(node.args[0]!);
        return { expression: { kind: 'count', section: section.id }, type: 'number' };
      }
      case 'sum':
      case 'min':
      case 'max':
      case 'average': {
        // Across a repeatable section: `sum([Radiators], [Output])`.
        if (name !== 'average' && node.args.length === 2 && this.#isSection(node.args[0])) {
          const { section, numbers } = this.#section(node.args[0]!);
          const inner = node.args[1]!;
          const question = numbers.find(
            (field) =>
              inner.kind === 'reference' &&
              (say(field.label, this.locale).trim() === inner.text || field.id === inner.text),
          );
          if (question === undefined) {
            throw new FormulaFailure({
              code: 'not_in_section',
              name: inner.kind === 'reference' ? inner.text : '',
              section: sectionName(section, this.locale),
            });
          }
          return {
            expression: {
              kind: 'aggregate',
              operator: name,
              section: section.id,
              field: question.id,
            },
            type: 'number',
          };
        }
        if (name === 'sum') {
          // A sum of several answers is plain addition.
          this.#arity(node, [2, MAX_STATISTIC_OPERANDS]);
          return {
            expression: node.args.slice(1).reduce<Expression>(
              (left, arg) => ({
                kind: 'arithmetic',
                operator: 'add',
                left,
                right: this.#number(arg),
              }),
              this.#number(node.args[0]!),
            ),
            type: 'number',
          };
        }
        this.#arity(node, [2, MAX_STATISTIC_OPERANDS]);
        return {
          expression: {
            kind: 'statistic',
            operator: name,
            operands: node.args.map((arg) => this.#number(arg)),
          },
          type: 'number',
        };
      }
      default:
        break;
    }
    if (DURATION.has(name)) {
      this.#arity(node, 2);
      const from = this.resolve(node.args[0]!);
      const to = this.resolve(node.args[1]!);
      if (from.type === 'number') {
        throw new FormulaFailure({ code: 'needs', expected: 'number_or_moment', found: 'number' });
      }
      if (from.type !== to.type) {
        throw new FormulaFailure({ code: 'mixed', left: from.type, right: to.type });
      }
      if (from.type === 'time' && name === 'days') {
        throw new FormulaFailure({ code: 'time_in_days' });
      }
      return {
        expression: {
          kind: 'difference',
          unit: name as DurationUnit,
          from: from.expression,
          to: to.expression,
        },
        type: 'number',
      };
    }
    const step = STEP[name];
    if (step !== undefined) {
      this.#arity(node, 2);
      return {
        expression: {
          kind: 'shift_date',
          operator: step.operator,
          unit: step.unit,
          date: this.#typed(node.args[0]!, 'date'),
          amount: this.#number(node.args[1]!),
        },
        type: 'date',
      };
    }
    throw new FormulaFailure({ code: 'unknown_function', name });
  }
}

function literal(text: string): { expression: Expression; type: FormulaType } {
  if (parseDate(text) !== undefined) {
    return { expression: { kind: 'date', value: text }, type: 'date' };
  }
  if (parseTime(text) !== undefined) {
    return { expression: { kind: 'time', value: text }, type: 'time' };
  }
  if (parseDatetime(text) !== undefined) {
    return { expression: { kind: 'datetime', value: text }, type: 'datetime' };
  }
  throw new FormulaFailure({ code: 'literal', text });
}

function sectionName(section: Section, locale: string): string {
  return (say(section.title, locale) || say(section.repeat?.entryLabel, locale)).trim();
}

/** A formula read into a calculation, or the first problem with it. */
export function parseFormula(
  source: string,
  sources: FormulaSources,
  locale: string,
  expected?: FormulaType,
): FormulaResult {
  if (source.trim() === '') {
    return { ok: false, problem: { code: 'empty' } };
  }
  const tokens = tokenize(source);
  if (!Array.isArray(tokens)) {
    return { ok: false, problem: tokens };
  }
  try {
    const tree = new Parser(tokens).parse();
    const { expression, type } = new Resolver(sources, locale).resolve(tree);
    if (expected !== undefined && type !== expected) {
      return { ok: false, problem: { code: 'result', expected, found: type } };
    }
    return { ok: true, expression, type };
  } catch (failure) {
    if (failure instanceof FormulaFailure) {
      return { ok: false, problem: failure.problem };
    }
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const PRECEDENCE = { add: 1, subtract: 1, multiply: 2, divide: 2 } as const;
const SYMBOL = { add: '+', subtract: '-', multiply: '*', divide: '/' } as const;

/**
 * A calculation as a formula, or `undefined` for one a formula cannot say
 * (a condition where a number belongs, written by hand). Brackets are added
 * wherever the tree needs them, so reading the text back gives the same tree.
 */
export function printFormula(
  expression: Expression,
  definition: FormDefinition,
  locale: string,
): string | undefined {
  const fields = definition.pages.flatMap((page) =>
    page.sections.flatMap((section) => section.fields.filter(isQuestion)),
  );
  const sections = definition.pages.flatMap((page) => page.sections);
  const reference = (id: string) => {
    const field = fields.find((candidate) => candidate.id === id);
    const wording = field === undefined ? '' : say(field.label, locale).trim();
    const unique =
      wording !== '' &&
      !/[[\]]/u.test(wording) &&
      fields.filter((candidate) => say(candidate.label, locale).trim() === wording).length === 1 &&
      !fields.some((candidate) => candidate.id === wording && candidate.id !== id);
    return `[${unique ? wording : id}]`;
  };
  const sectionReference = (id: string) => {
    const section = sections.find((candidate) => candidate.id === id);
    const name = section === undefined ? '' : sectionName(section, locale);
    const clash =
      name === '' ||
      /[[\]]/u.test(name) ||
      fields.some((field) => say(field.label, locale).trim() === name);
    return `[${clash ? id : name}]`;
  };

  const print = (node: Expression): { text: string; precedence: number } | undefined => {
    const atom = (text: string) => ({ text, precedence: 3 });
    const all = (nodes: Expression[]) => {
      const printed = nodes.map((inner) => print(inner)?.text);
      return printed.every((text) => text !== undefined) ? printed.join(', ') : undefined;
    };
    switch (node.kind) {
      case 'number':
        return { text: node.value, precedence: node.value.startsWith('-') ? 2.5 : 3 };
      case 'date':
      case 'time':
      case 'datetime':
        return atom(`"${node.value}"`);
      case 'answer':
        return atom(reference(node.field));
      case 'today':
        return atom('today');
      case 'now':
        return atom('now');
      case 'count':
        return atom(`count(${sectionReference(node.section)})`);
      case 'aggregate':
        return atom(
          `${node.operator}(${sectionReference(node.section)}, ${reference(node.field)})`,
        );
      case 'arithmetic': {
        const own = PRECEDENCE[node.operator];
        const left = print(node.left);
        const right = print(node.right);
        if (left === undefined || right === undefined) {
          return undefined;
        }
        const leftText = left.precedence < own ? `(${left.text})` : left.text;
        const rightText = right.precedence <= own ? `(${right.text})` : right.text;
        return { text: `${leftText} ${SYMBOL[node.operator]} ${rightText}`, precedence: own };
      }
      case 'round': {
        const inner = print(node.operand);
        return inner === undefined
          ? undefined
          : atom(`round(${inner.text}, ${String(node.places)})`);
      }
      case 'percentage': {
        const inner = all([node.part, node.whole]);
        return inner === undefined ? undefined : atom(`percent(${inner})`);
      }
      case 'statistic': {
        const inner = all(node.operands);
        return inner === undefined || node.operands.length < 2
          ? undefined
          : atom(`${node.operator}(${inner})`);
      }
      case 'difference': {
        const inner = all([node.from, node.to]);
        return inner === undefined ? undefined : atom(`${node.unit}(${inner})`);
      }
      case 'shift_date': {
        const inner = all([node.date, node.amount]);
        return inner === undefined ? undefined : atom(`${node.operator}_${node.unit}(${inner})`);
      }
      default:
        return undefined;
    }
  };
  return print(expression)?.text;
}

// ---------------------------------------------------------------------------
// Suggestions as you type
// ---------------------------------------------------------------------------

export interface FormulaSuggestion {
  /** What the list shows. */
  label: string;
  /** What replaces the text being typed. */
  insert: string;
  /** Where in the text the replacement starts. */
  from: number;
}

/**
 * What to offer at the caret: questions and sections while a `[` is open,
 * functions while a name is being typed. Nothing otherwise.
 */
export function suggestionsAt(
  text: string,
  caret: number,
  sources: FormulaSources,
  locale: string,
): FormulaSuggestion[] {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('[');
  if (open !== -1 && !before.slice(open).includes(']')) {
    const typed = before.slice(open + 1).toLocaleLowerCase(locale);
    const names = [
      ...sources.questions.map((field) => say(field.label, locale).trim() || field.id),
      ...sources.sections.map(({ section }) => sectionName(section, locale) || section.id),
    ];
    const found = [...new Set(names)].filter((name) =>
      name.toLocaleLowerCase(locale).includes(typed),
    );
    // Wordings that start with what was typed first, then those that contain it.
    const starts = (name: string) => name.toLocaleLowerCase(locale).startsWith(typed);
    return [...found.filter(starts), ...found.filter((name) => !starts(name))]
      .slice(0, 12)
      .map((name) => ({ label: name, insert: `[${name}]`, from: open }));
  }
  const name = /[A-Za-z_]+$/u.exec(before);
  if (name === null) {
    return [];
  }
  const typed = name[0].toLowerCase();
  return FUNCTIONS.filter((candidate) => candidate.startsWith(typed) && candidate !== typed).map(
    (candidate) => ({
      label: candidate,
      insert: FUNCTION_TEMPLATES[candidate],
      from: caret - name[0].length,
    }),
  );
}
