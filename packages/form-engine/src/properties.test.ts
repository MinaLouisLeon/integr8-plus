import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { compileDefinition } from './compile.js';
import { snapshotView } from './conformance/snapshot.js';
import type { FormDefinition, Page, Section } from './definition.js';
import type { Expression } from './expression.js';
import type { Field } from './field-types.js';
import { createFormState, type FormEvent, toSubmission, transition, viewForm } from './state.js';
import { validateForm, validateSubmission } from './validation.js';

/**
 * Properties over generated forms.
 *
 * The unit tests pin down behaviour someone thought of. These generate forms
 * nobody thought of — random pages, sections, field types, conditions and
 * calculations, answered in random orders — and check the things that must
 * hold for every one of them.
 *
 * Generated forms are acyclic by construction: a condition only reads fields
 * that come earlier, and a section or page condition only reads fields from
 * before it starts. Then separate properties break that rule on purpose and
 * check the cycle is caught.
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const GENERATED_TYPES = [
  'text',
  'number',
  'decimal',
  'checkbox',
  'yes_no',
  'radio',
  'multi_select',
  'date',
] as const;
type GeneratedType = (typeof GENERATED_TYPES)[number];

const OPTIONS = ['red', 'green', 'blue'];

interface Plan {
  pages: { sections: { fields: GeneratedType[]; conditioned: boolean }[]; conditioned: boolean }[];
  seed: number[];
}

const planArbitrary: fc.Arbitrary<Plan> = fc.record({
  pages: fc.array(
    fc.record({
      conditioned: fc.boolean(),
      sections: fc.array(
        fc.record({
          conditioned: fc.boolean(),
          fields: fc.array(fc.constantFrom(...GENERATED_TYPES), { minLength: 1, maxLength: 5 }),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  // A stream of choices the builder below consumes, so shrinking stays meaningful.
  seed: fc.array(fc.nat(1_000), { minLength: 64, maxLength: 64 }),
});

/** Builds a definition from a plan. Deterministic in the plan. */
function buildDefinition(plan: Plan): FormDefinition {
  let cursor = 0;
  const pick = (count: number) => {
    const value = plan.seed[cursor % plan.seed.length] ?? 0;
    cursor += 1;
    return value % count;
  };

  const earlier: { id: string; type: GeneratedType }[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${String((counter += 1))}`;

  const condition = (
    candidates: readonly { id: string; type: GeneratedType }[],
  ): Expression | undefined => {
    if (candidates.length === 0) {
      return undefined;
    }
    const target = candidates[pick(candidates.length)]!;
    const leaf = (): Expression => {
      switch (target.type) {
        case 'yes_no':
          return {
            kind: 'compare',
            operator: 'eq',
            left: { kind: 'answer', field: target.id },
            right: { kind: 'text', value: pick(2) === 0 ? 'yes' : 'no' },
          };
        case 'radio':
          return {
            kind: 'compare',
            operator: 'ne',
            left: { kind: 'answer', field: target.id },
            right: { kind: 'text', value: OPTIONS[pick(3)]! },
          };
        case 'multi_select':
          return { kind: 'includes', field: target.id, option: OPTIONS[pick(3)]! };
        case 'number':
        case 'decimal':
          return {
            kind: 'compare',
            operator: pick(2) === 0 ? 'gt' : 'le',
            left: { kind: 'answer', field: target.id },
            right: { kind: 'number', value: String(pick(20) - 5) },
          };
        case 'checkbox':
          return {
            kind: 'compare',
            operator: 'eq',
            left: { kind: 'answer', field: target.id },
            right: { kind: 'boolean', value: true },
          };
        case 'date':
          return {
            kind: 'compare',
            operator: 'lt',
            left: { kind: 'answer', field: target.id },
            right: { kind: 'today' },
          };
        default:
          return { kind: 'answered', field: target.id };
      }
    };

    switch (pick(4)) {
      case 0:
        return { kind: 'not', operand: leaf() };
      case 1:
        return { kind: 'any', operands: [leaf(), { kind: 'answered', field: target.id }] };
      default:
        return leaf();
    }
  };

  const makeField = (type: GeneratedType): Field => {
    const id = nextId('f');
    const base = { id, label: { en: id } };
    const visibleWhen = pick(3) === 0 ? condition(earlier) : undefined;
    const common = {
      ...base,
      ...(visibleWhen === undefined ? {} : { visibleWhen }),
      ...(pick(3) === 0 ? { required: true } : {}),
    };

    switch (type) {
      case 'text':
        return { ...common, type, maxLength: 1 + pick(8) };
      case 'number':
        return { ...common, type, min: -3, max: 3 + pick(5) };
      case 'decimal': {
        const numeric = earlier.filter(
          (other) => other.type === 'number' || other.type === 'decimal',
        );
        const source =
          numeric.length > 0 && pick(2) === 0 ? numeric[pick(numeric.length)] : undefined;
        if (source !== undefined) {
          const { required: _required, ...withoutRequired } = common as typeof common & {
            required?: boolean;
          };
          return {
            ...withoutRequired,
            type,
            decimalPlaces: pick(3),
            calculation: {
              kind: 'arithmetic',
              operator: pick(2) === 0 ? 'multiply' : 'divide',
              left: { kind: 'answer', field: source.id },
              right: { kind: 'number', value: '3' },
            },
          };
        }
        return { ...common, type, decimalPlaces: 1 + pick(2), max: '9.9' };
      }
      case 'checkbox':
        return { ...common, type };
      case 'yes_no':
        return { ...common, type, allowNotApplicable: pick(2) === 0 };
      case 'radio':
        return {
          ...common,
          type,
          options: OPTIONS.map((value) => ({ value, label: { en: value } })),
        };
      case 'multi_select':
        return {
          ...common,
          type,
          options: OPTIONS.map((value) => ({ value, label: { en: value } })),
          maxSelected: 2,
        };
      case 'date':
        return { ...common, type, earliest: '2020-01-01' };
    }
  };

  const pages: Page[] = plan.pages.map((pagePlan) => {
    const pageCondition = pagePlan.conditioned ? condition(earlier) : undefined;
    const pageId = nextId('p');

    const sections: Section[] = pagePlan.sections.map((sectionPlan) => {
      const sectionCondition = sectionPlan.conditioned ? condition(earlier) : undefined;
      const sectionId = nextId('s');
      const fields = sectionPlan.fields.map((type) => {
        const built = makeField(type);
        earlier.push({ id: built.id, type });
        return built;
      });
      return {
        id: sectionId,
        fields,
        ...(sectionCondition === undefined ? {} : { visibleWhen: sectionCondition }),
      };
    });

    return {
      id: pageId,
      sections,
      ...(pageCondition === undefined ? {} : { visibleWhen: pageCondition }),
    };
  });

  // Every form gets a plain number up front and a calculation over it at the
  // end, so calculated values are exercised in most scenarios rather than the
  // handful where the random plan happened to line one up.
  const anchor: Field = { id: 'anchor', type: 'number', label: { en: 'anchor' } };
  const derived: Field = {
    id: 'derived',
    type: 'decimal',
    label: { en: 'derived' },
    decimalPlaces: 2,
    calculation: {
      kind: 'arithmetic',
      operator: 'divide',
      left: { kind: 'answer', field: 'anchor' },
      right: { kind: 'number', value: '7' },
    },
  };
  const firstSection = pages[0]!.sections[0]!;
  const lastPage = pages[pages.length - 1]!;
  const lastSection = lastPage.sections[lastPage.sections.length - 1]!;
  firstSection.fields.unshift(anchor);
  lastSection.fields.push(derived);

  return { schemaVersion: 1, title: { en: 'Generated' }, pages };
}

/** A plausible answer, sometimes wrong, for a field. */
function answerFor(field: Field, choice: number): unknown {
  switch (field.type) {
    case 'text':
      return ['', 'a', 'abcdefghij', 'شريف'][choice % 4];
    case 'number':
      return [-5, 0, 2, 9, 22, -13][choice % 6];
    case 'decimal':
      return ['0', '1.5', '9.95', '-2.25'][choice % 4];
    case 'checkbox':
      return choice % 2 === 0;
    case 'yes_no':
      return ['yes', 'no', 'not_applicable'][choice % 3];
    case 'radio':
      return ['red', 'green', 'purple'][choice % 3];
    case 'multi_select':
      return [[], ['red'], ['red', 'green', 'blue'], ['red', 'red']][choice % 4];
    case 'date':
      return ['2019-12-31', '2026-02-28', '2026-09-30'][choice % 3];
    default:
      return undefined;
  }
}

const scenarioArbitrary = fc.record({
  plan: planArbitrary,
  events: fc.array(
    fc.tuple(
      fc.nat(10_000),
      fc.nat(10_000),
      fc.constantFrom('answer', 'answer', 'answer', 'clear', 'touch'),
    ),
    { maxLength: 25 },
  ),
});

function play(definition: FormDefinition, events: readonly [number, number, string][]) {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(
      `generated definition did not compile: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const form = result.form;
  let state = createFormState(form);
  for (const [which, choice, kind] of events) {
    const field = which % 3 === 0 ? form.fields[0]! : form.fields[which % form.fields.length]!;
    const event: FormEvent =
      kind === 'clear'
        ? { type: 'clear', field: field.id }
        : kind === 'touch'
          ? { type: 'touch', field: field.id }
          : { type: 'answer', field: field.id, value: answerFor(field, choice) };
    state = transition(form, state, event, CONTEXT).state;
  }
  return { form, state };
}

const CONTEXT = { today: '2026-09-13' };
const RUNS = { numRuns: 300 };

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('every generated form', () => {
  it('compiles, and evaluates every element exactly once in its order', () => {
    fc.assert(
      fc.property(planArbitrary, (plan) => {
        const result = compileDefinition(buildDefinition(plan));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect([...result.form.evaluationOrder].sort()).toEqual(
            [...result.form.elements.keys()].sort(),
          );
        }
      }),
      RUNS,
    );
  });

  it('decides the same thing after a JSON round trip, as when it is stored in Postgres and read back', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const definition = buildDefinition(plan);
        const original = play(definition, events);
        const reloaded = play(JSON.parse(JSON.stringify(definition)) as FormDefinition, events);

        expect(
          canonicalJson(
            snapshotView(reloaded.form, viewForm(reloaded.form, reloaded.state, CONTEXT)),
          ),
        ).toBe(
          canonicalJson(
            snapshotView(original.form, viewForm(original.form, original.state, CONTEXT)),
          ),
        );
      }),
      RUNS,
    );
  });

  it('does not care what order the answers were stored in', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const reversed = Object.fromEntries(Object.entries(state.answers).reverse());

        expect(
          canonicalJson(
            snapshotView(form, viewForm(form, { ...state, answers: reversed }, CONTEXT)),
          ),
        ).toBe(canonicalJson(snapshotView(form, viewForm(form, state, CONTEXT))));
      }),
      RUNS,
    );
  });

  it('never shows a field inside something hidden, and never gives a hidden field a value or an error', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const view = viewForm(form, state, CONTEXT);

        for (const element of form.elements.values()) {
          if (view.visible.get(element.id) === true && element.parent !== undefined) {
            expect(view.visible.get(element.parent)).toBe(true);
          }
          if (element.kind === 'field' && view.visible.get(element.id) !== true) {
            expect(view.values.has(element.id)).toBe(false);
            expect(view.errors.some((error) => error.field === element.id)).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });

  it('produces a submission the server accepts as well-formed, whenever the phone thinks it is valid', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const submission = toSubmission(form, state, CONTEXT);
        const server = validateSubmission(form, submission, CONTEXT);
        const phone = validateForm(form, state.answers, CONTEXT);

        // Nothing the engine itself sends is ever a stray, hidden or calculated key.
        expect(server.issues).toEqual([]);
        // The server and the phone agree on validity and on every error.
        expect(server.valid).toBe(phone.valid);
        expect(server.errors).toEqual(phone.errors);
      }),
      RUNS,
    );
  });

  it('keeps progress coherent', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ plan, events }) => {
        const { form, state } = play(buildDefinition(plan), events);
        const { progress, valid, errors } = viewForm(form, state, CONTEXT);

        expect(progress.requiredAnswered).toBeLessThanOrEqual(progress.requiredTotal);
        expect(progress.answered).toBeLessThanOrEqual(progress.total);
        expect(progress.requiredTotal).toBeLessThanOrEqual(progress.total);
        expect(valid).toBe(errors.length === 0);
        if (valid) {
          expect(progress.requiredAnswered).toBe(progress.requiredTotal);
        }
      }),
      RUNS,
    );
  });

  it('treats answering the same thing twice exactly like answering it once', () => {
    fc.assert(
      fc.property(scenarioArbitrary, fc.nat(), fc.nat(), ({ plan, events }, which, choice) => {
        const { form, state } = play(buildDefinition(plan), events);
        const field = form.fields[which % form.fields.length]!;
        const event: FormEvent = {
          type: 'answer',
          field: field.id,
          value: answerFor(field, choice),
        };

        const once = transition(form, state, event, CONTEXT).state;
        const twice = transition(form, once, event, CONTEXT).state;
        expect(twice).toEqual(once);
      }),
      RUNS,
    );
  });
});

describe('a cycle introduced into a generated form', () => {
  it('is always refused when a field is made to depend on itself, and the field is named', () => {
    fc.assert(
      fc.property(planArbitrary, fc.nat(), (plan, which) => {
        const definition = buildDefinition(plan);
        const fields = definition.pages.flatMap((page) =>
          page.sections.flatMap((section) => section.fields),
        );
        const target = fields[which % fields.length]!;
        target.visibleWhen = { kind: 'answered', field: target.id };

        const result = compileDefinition(definition);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          const cycle = result.issues.find(
            (issue) => issue.code === 'circular_dependency' && issue.elements.includes(target.id),
          );
          expect(cycle?.message).toContain(`"${target.id}"`);
        }
      }),
      RUNS,
    );
  });

  it('is always refused when an earlier field is made to depend on a later one that already depends on it', () => {
    fc.assert(
      fc.property(planArbitrary, (plan) => {
        const definition = buildDefinition(plan);
        const fields = definition.pages.flatMap((page) =>
          page.sections.flatMap((section) => section.fields),
        );
        const dependent = fields.find(
          (candidate) =>
            candidate.visibleWhen?.kind === 'answered' || candidate.visibleWhen?.kind === 'compare',
        );
        fc.pre(dependent !== undefined);

        const readsExpression = dependent.visibleWhen!;
        const reads =
          readsExpression.kind === 'answered'
            ? readsExpression.field
            : readsExpression.kind === 'compare' && readsExpression.left.kind === 'answer'
              ? readsExpression.left.field
              : undefined;
        fc.pre(reads !== undefined && reads !== dependent.id);

        const source = fields.find((candidate) => candidate.id === reads)!;
        source.visibleWhen = { kind: 'answered', field: dependent.id };

        const result = compileDefinition(definition);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          const cycle = result.issues.find((issue) => issue.code === 'circular_dependency');
          expect(cycle?.elements).toEqual(expect.arrayContaining([source.id, dependent.id]));
        }
      }),
      RUNS,
    );
  });
});
