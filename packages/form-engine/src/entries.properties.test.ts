import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { compileDefinition, type CompiledForm } from './compile.js';
import { snapshotView } from './conformance/snapshot.js';
import type { FormDefinition, Section } from './definition.js';
import { storedEntries } from './evaluate.js';
import type { Expression } from './expression.js';
import type { Field } from './field-types.js';
import {
  createFormState,
  type FormEvent,
  type FormState,
  toSubmission,
  transition,
  viewForm,
} from './state.js';
import { validateForm, validateSubmission } from './validation.js';

/**
 * Properties over generated forms with repeatable sections (P13b).
 *
 * The same guarantees as `properties.test.ts` — the phone and the server agree,
 * storage order does not matter, hidden means absent — over forms where some
 * sections repeat, rules read inside an entry and across entries, and a person
 * adds, removes and reorders entries in any order.
 *
 * Generated forms are acyclic and well-scoped by construction: a field reads
 * only fields before it, a field outside a repeatable section reads its entries
 * only across them, and a field inside one reads its own entry's earlier fields
 * or anything outside before it.
 */

type GeneratedType = 'text' | 'number' | 'decimal' | 'checkbox' | 'radio';
const TYPES: readonly GeneratedType[] = ['text', 'number', 'decimal', 'checkbox', 'radio'];
const OPTIONS = ['red', 'green', 'blue'];

interface Plan {
  sections: { repeat: boolean; min: number; max: number; fields: GeneratedType[] }[];
  seed: number[];
}

const planArbitrary: fc.Arbitrary<Plan> = fc.record({
  sections: fc.array(
    fc.record({
      repeat: fc.boolean(),
      min: fc.nat(1),
      max: fc.integer({ min: 1, max: 3 }),
      fields: fc.array(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 4 }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  seed: fc.array(fc.nat(1_000), { minLength: 64, maxLength: 64 }),
});

interface Known {
  id: string;
  type: GeneratedType;
  /** The repeatable section the field is in. */
  section: string | undefined;
}

function buildDefinition(plan: Plan): FormDefinition {
  let cursor = 0;
  const pick = (count: number) => {
    const value = plan.seed[cursor % plan.seed.length] ?? 0;
    cursor += 1;
    return value % count;
  };
  const earlier: Known[] = [];
  const finishedRepeats: string[] = [];

  const leaf = (target: Known): Expression => {
    const answer: Expression = { kind: 'answer', field: target.id };
    switch (target.type) {
      case 'number':
      case 'decimal':
        return {
          kind: 'compare',
          operator: pick(2) === 0 ? 'gt' : 'le',
          left: answer,
          right: { kind: 'number', value: String(pick(10) - 3) },
        };
      case 'checkbox':
        return {
          kind: 'compare',
          operator: 'eq',
          left: answer,
          right: { kind: 'boolean', value: true },
        };
      case 'radio':
        return {
          kind: 'compare',
          operator: 'ne',
          left: answer,
          right: { kind: 'text', value: OPTIONS[pick(3)]! },
        };
      default:
        return { kind: 'answered', field: target.id };
    }
  };

  /** A condition for something in \`within\` (a repeatable section, or none). */
  const condition = (within: string | undefined): Expression | undefined => {
    const direct = earlier.filter(
      (known) => known.section === undefined || known.section === within,
    );
    const choice = pick(4);
    if (choice === 0 && finishedRepeats.length > 0) {
      const section = finishedRepeats[pick(finishedRepeats.length)]!;
      const inner = earlier.filter((known) => known.section === section);
      const numeric = inner.filter((known) => known.type === 'number' || known.type === 'decimal');
      switch (pick(3)) {
        case 0:
          return {
            kind: 'compare',
            operator: 'ge',
            left: { kind: 'count', section },
            right: { kind: 'number', value: String(pick(3)) },
          };
        case 1:
          if (numeric.length > 0) {
            return {
              kind: 'compare',
              operator: 'gt',
              left: {
                kind: 'aggregate',
                operator: (['sum', 'min', 'max'] as const)[pick(3)]!,
                section,
                field: numeric[pick(numeric.length)]!.id,
              },
              right: { kind: 'number', value: '1' },
            };
          }
          return undefined;
        default:
          return {
            kind: pick(2) === 0 ? 'some' : 'every',
            section,
            condition: leaf(inner[pick(inner.length)]!),
          };
      }
    }
    if (direct.length === 0 || choice === 1) {
      return undefined;
    }
    const target = direct[pick(direct.length)]!;
    return pick(3) === 0 ? { kind: 'not', operand: leaf(target) } : leaf(target);
  };

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${String((counter += 1))}`;

  const makeField = (type: GeneratedType, within: string | undefined): Field => {
    const id = nextId('f');
    const visibleWhen = pick(3) === 0 ? condition(within) : undefined;
    const common = {
      id,
      label: { en: id },
      ...(visibleWhen === undefined ? {} : { visibleWhen }),
      ...(pick(3) === 0 ? { required: true } : {}),
    };
    switch (type) {
      case 'text':
        return { ...common, type, maxLength: 1 + pick(6) };
      case 'number':
        return { ...common, type, max: 5 + pick(5) };
      case 'decimal': {
        const readable = earlier.filter(
          (known) =>
            (known.type === 'number' || known.type === 'decimal') &&
            (known.section === undefined || known.section === within),
        );
        if (readable.length > 0 && pick(2) === 0) {
          const { required: _required, ...rest } = common as typeof common & { required?: boolean };
          return {
            ...rest,
            type,
            decimalPlaces: 1,
            calculation: {
              kind: 'arithmetic',
              operator: 'add',
              left: { kind: 'answer', field: readable[pick(readable.length)]!.id },
              right: { kind: 'number', value: '1' },
            },
          };
        }
        return { ...common, type, decimalPlaces: 1 };
      }
      case 'checkbox':
        return { ...common, type };
      case 'radio':
        return {
          ...common,
          type,
          options: OPTIONS.map((value) => ({ value, label: { en: value } })),
        };
    }
  };

  const sections: Section[] = plan.sections.map((sectionPlan) => {
    const id = nextId('s');
    const within = sectionPlan.repeat ? id : undefined;
    const visibleWhen = pick(4) === 0 ? condition(undefined) : undefined;
    const fields = sectionPlan.fields.map((type) => {
      const built = makeField(type, within);
      earlier.push({ id: built.id, type, section: within });
      return built;
    });
    if (within !== undefined) {
      finishedRepeats.push(within);
    }
    return {
      id,
      fields,
      ...(visibleWhen === undefined ? {} : { visibleWhen }),
      ...(sectionPlan.repeat
        ? {
            repeat: {
              maxEntries: sectionPlan.max,
              ...(sectionPlan.min > 0
                ? { minEntries: Math.min(sectionPlan.min, sectionPlan.max) }
                : {}),
              entryLabel: { en: 'Entry' },
            },
          }
        : {}),
    };
  });

  return { schemaVersion: 1, title: { en: 'Generated' }, pages: [{ id: 'page', sections }] };
}

function answerFor(field: Field, choice: number): unknown {
  switch (field.type) {
    case 'text':
      return ['', 'a', 'abcdefgh', 'شريف'][choice % 4];
    case 'number':
      return [-2, 0, 3, 12][choice % 4];
    case 'decimal':
      return ['0', '1.5', '2.25', '-4.0'][choice % 4];
    case 'checkbox':
      return choice % 2 === 0;
    case 'radio':
      return ['red', 'green', 'purple'][choice % 3];
    default:
      return undefined;
  }
}

type Step = [which: number, choice: number, kind: string];

const scenarioArbitrary = fc.record({
  plan: planArbitrary,
  events: fc.array(
    fc.tuple(
      fc.nat(10_000),
      fc.nat(10_000),
      fc.constantFrom(
        'answer',
        'answer',
        'answer',
        'clear',
        'touch',
        'add',
        'add',
        'remove',
        'move',
      ),
    ),
    { maxLength: 30 },
  ),
});

const CONTEXT = { today: '2026-09-13' };
const RUNS = { numRuns: 300 };

function compile(definition: FormDefinition): CompiledForm {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(
      `generated definition did not compile: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return result.form;
}

function eventFor(
  form: CompiledForm,
  state: FormState,
  [which, choice, kind]: Step,
  added: number,
): FormEvent {
  const sections = [...form.elements.values()].filter((element) => element.repeat !== undefined);
  if (kind === 'add' || kind === 'remove' || kind === 'move') {
    if (sections.length === 0) {
      return { type: 'touch', field: form.fields[which % form.fields.length]!.id };
    }
    const section = sections[which % sections.length]!.id;
    const entries = storedEntries(state.answers, section);
    if (kind === 'add' || entries.length === 0) {
      return {
        type: 'add_entry',
        section,
        entry: `e${String(added)}`,
        index: choice % (entries.length + 1),
      };
    }
    const entry = entries[choice % entries.length]!.id;
    return kind === 'remove'
      ? { type: 'remove_entry', section, entry }
      : { type: 'move_entry', section, entry, index: which % entries.length };
  }
  const field = form.fields[which % form.fields.length]!;
  const section = form.elements.get(field.id)?.entries;
  const entries = section === undefined ? [] : storedEntries(state.answers, section);
  const entry =
    section === undefined ? undefined : entries[choice % Math.max(entries.length, 1)]?.id;
  const at = entry === undefined ? {} : { entry };
  if (section !== undefined && entry === undefined) {
    return { type: 'add_entry', section, entry: `e${String(added)}` };
  }
  return kind === 'clear'
    ? { type: 'clear', field: field.id, ...at }
    : kind === 'touch'
      ? { type: 'touch', field: field.id, ...at }
      : { type: 'answer', field: field.id, value: answerFor(field, choice), ...at };
}

function play(definition: FormDefinition, events: readonly Step[]) {
  const form = compile(definition);
  let state = createFormState(form);
  events.forEach((step, index) => {
    state = transition(form, state, eventFor(form, state, step, index), CONTEXT).state;
  });
  return { form, state };
}

const snapshot = (form: CompiledForm, state: FormState) =>
  canonicalJson(snapshotView(form, viewForm(form, state, CONTEXT)));

/** The same answers, every object's keys stored in reverse. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reversed);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, reversed(inner)]),
    );
  }
  return value;
}

describe('every generated form with repeatable sections', () => {
  it('compiles, and evaluates every element exactly once in its order', () => {
    fc.assert(
      fc.property(planArbitrary, (plan) => {
        const form = compile(buildDefinition(plan));
        expect([...form.evaluationOrder].sort()).toEqual([...form.elements.keys()].sort());
      }),
      RUNS,
    );
  });

  it('decides the same thing after a JSON round trip, and whatever order keys were stored in', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const definition = buildDefinition(plan);
        const original = play(definition, events);
        const reloaded = play(JSON.parse(JSON.stringify(definition)) as FormDefinition, events);
        const expected = snapshot(original.form, original.state);
        expect(snapshot(reloaded.form, reloaded.state)).toBe(expected);
        expect(
          snapshot(original.form, {
            ...original.state,
            answers: reversed(original.state.answers) as FormState['answers'],
          }),
        ).toBe(expected);
      }),
      RUNS,
    );
  });

  it('never gives a hidden entry field a value or an error, and a hidden section no entries', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const view = viewForm(form, state, CONTEXT);
        for (const [section, entries] of view.entries) {
          if (view.visible.get(section) !== true) {
            expect(entries).toEqual([]);
            expect(view.values.has(section)).toBe(false);
          }
          for (const entry of entries) {
            for (const [field, shown] of entry.visible) {
              if (!shown) {
                expect(entry.values.has(field)).toBe(false);
                expect(
                  view.errors.some((error) => error.field === field && error.entry === entry.id),
                ).toBe(false);
              }
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('produces a submission the server accepts as well-formed, and agrees with the phone on every error', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const submission = toSubmission(form, state, CONTEXT);
        const server = validateSubmission(form, JSON.parse(JSON.stringify(submission)), CONTEXT);
        const phone = validateForm(form, state.answers, CONTEXT);
        expect(server.issues).toEqual([]);
        expect(server.valid).toBe(phone.valid);
        expect(server.errors).toEqual(phone.errors);
      }),
      RUNS,
    );
  });

  it('keeps progress coherent, and the entries within their limits', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const { progress, valid, errors } = viewForm(form, state, CONTEXT);
        expect(progress.requiredAnswered).toBeLessThanOrEqual(progress.requiredTotal);
        expect(progress.answered).toBeLessThanOrEqual(progress.total);
        expect(progress.requiredTotal).toBeLessThanOrEqual(progress.total);
        expect(valid).toBe(errors.length === 0);
        for (const element of form.elements.values()) {
          if (element.repeat !== undefined) {
            expect(storedEntries(state.answers, element.id).length).toBeLessThanOrEqual(
              element.repeat.maxEntries,
            );
            expect(errors.some((error) => error.code === 'too_many_entries')).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });

  it('refuses a field of a repeatable section read from outside its entries, naming both', () => {
    fc.assert(
      fc.property(planArbitrary, fc.nat(), (plan, which) => {
        const definition = buildDefinition(plan);
        const sections = definition.pages[0]!.sections;
        const inner = sections
          .filter((section) => section.repeat !== undefined)
          .flatMap((section) => section.fields);
        const outer = sections
          .filter((section) => section.repeat === undefined)
          .flatMap((section) => section.fields);
        fc.pre(inner.length > 0 && outer.length > 0);
        const target = inner[which % inner.length]!;
        const reader = outer[which % outer.length]!;
        reader.visibleWhen = { kind: 'answered', field: target.id };

        const result = compileDefinition(definition);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(
            result.issues.some(
              (issue) => issue.code === 'inside_repeat' && issue.elements.includes(target.id),
            ),
          ).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
