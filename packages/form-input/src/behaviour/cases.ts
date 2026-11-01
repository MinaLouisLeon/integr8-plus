import {
  type Answers,
  compileDefinition,
  type CompiledForm,
  createFormState,
  type Field,
  type FormDefinition,
  type FormEvent,
  type FormState,
  isQuestion,
  transition,
} from '@integr8/form-engine';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import { EVERYTHING_FORM } from './fixture.js';

/**
 * The forms and the answers the behaviour check fills them with.
 *
 * Each case is a form and a list of steps; each step is a set of answers and
 * whether "submit" has been tried. A renderer under test opens the form with a
 * step's answers (as every renderer can: the phone from its stored row, the web
 * from a saved draft, the preview from its state) and, for a submitted step,
 * presses its own Review button. What it then shows is compared with
 * `expectedScreen`.
 *
 * The answers are made by the engine's own `transition`, one answer at a time,
 * so a question revealed by an earlier answer is answered too, and an answer the
 * engine refuses is simply not there. Entry ids are numbered so every renderer
 * sees the same ones.
 */

export const BEHAVIOUR_TODAY = '2026-09-13';

export interface BehaviourStep {
  /** What the step does, for a failing test's name. */
  name: string;
  answers: Answers;
  /** Whether the person has pressed Review (the engine's `submit`). */
  submitted: boolean;
}

export interface BehaviourCase {
  key: string;
  form: CompiledForm;
  steps: BehaviourStep[];
}

/** Ids for entries, the same in every renderer: `entry-1`, `entry-2`, … */
export function entryIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `entry-${String(next)}`;
  };
}

/** The state a renderer is in after opening a step: its answers, then Review if it was pressed. */
export function stateOf(form: CompiledForm, step: BehaviourStep): FormState {
  const opened = createFormState(form, step.answers, { newEntryId: entryIds() });
  return step.submitted
    ? transition(form, opened, { type: 'submit' }, { today: BEHAVIOUR_TODAY }).state
    : opened;
}

export function compileOrThrow(definition: FormDefinition): CompiledForm {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join('\n'));
  }
  return result.form;
}

/** The six library forms and the every-type form, each with its steps. */
export function behaviourCases(): BehaviourCase[] {
  return [
    ...FORM_TEMPLATES.map((template) => {
      const form = compileOrThrow(template.definition);
      return { key: template.key, form, steps: genericSteps(form) };
    }),
    (() => {
      const form = compileOrThrow(EVERYTHING_FORM);
      return { key: 'everything', form, steps: [...genericSteps(form), ...everythingSteps(form)] };
    })(),
  ];
}

type Variant = 'first' | 'last';

/**
 * The same seven steps for any form: opened; Review pressed on an empty form;
 * every question answered with its first option or a plain valid value, before
 * and after Review; with its last option or a value most rules refuse; two
 * entries added to each repeating section with the first one filled, before
 * and after Review.
 */
function genericSteps(form: CompiledForm): BehaviourStep[] {
  const empty = createFormState(form, {}, { newEntryId: entryIds() }).answers;
  return [
    { name: 'opened', answers: empty, submitted: false },
    { name: 'review pressed with nothing answered', answers: empty, submitted: true },
    { name: 'first choices, plain values', answers: fillAll(form, 'first'), submitted: false },
    { name: 'first choices, Review pressed', answers: fillAll(form, 'first'), submitted: true },
    { name: 'last choices, refused values', answers: fillAll(form, 'last'), submitted: true },
    { name: 'entries added, first one filled', answers: withEntries(form), submitted: false },
    { name: 'entries added, Review pressed', answers: withEntries(form), submitted: true },
  ];
}

/** Steps only the every-type form has: one rule at a time. */
function everythingSteps(form: CompiledForm): BehaviourStep[] {
  const base = fillAll(form, 'first');
  const play = (events: FormEvent[], from: Answers = base): Answers => apply(form, from, events);
  return [
    {
      name: 'fail reveals a question, a section, and makes the reason required',
      answers: play([
        { type: 'answer', field: 'result', value: 'fail' },
        { type: 'clear', field: 'reason' },
        { type: 'clear', field: 'failure_code' },
      ]),
      submitted: true,
    },
    {
      name: 'gas narrows the protection to a mask; height adds a harness',
      answers: play([
        { type: 'answer', field: 'hazards', value: ['gas'] },
        { type: 'answer', field: 'protection', value: 'harness' },
      ]),
      submitted: true,
    },
    {
      name: 'a custom check and a format refuse their answers in the admin’s words',
      answers: play([
        { type: 'answer', field: 'readings', value: 9 },
        { type: 'answer', field: 'serial', value: 'lower case' },
      ]),
      submitted: true,
    },
    {
      name: 'entries read across: too few, one not bled, too much output',
      answers: play(
        [
          { type: 'answer', field: 'output', value: 4000, entry: 'radiators-1' },
          { type: 'answer', field: 'bled', value: 'no', entry: 'radiators-1' },
        ],
        withEntries(form, 1),
      ),
      submitted: true,
    },
    {
      name: 'the form left before the evidence page shows',
      answers: play([{ type: 'clear', field: 'result' }]),
      submitted: true,
    },
  ];
}

function apply(form: CompiledForm, answers: Answers, events: readonly FormEvent[]): Answers {
  let state = createFormState(form, answers, { newEntryId: entryIds() });
  for (const event of events) {
    state = transition(form, state, event, { today: BEHAVIOUR_TODAY }).state;
  }
  return state.answers;
}

/** Answers every question it can, twice over so revealed questions get theirs too. */
function fillAll(form: CompiledForm, variant: Variant): Answers {
  const fields = form.definition.pages.flatMap((page) =>
    page.sections
      .filter((section) => section.repeat === undefined)
      .flatMap((s) => s.fields.filter(isQuestion)),
  );
  const events = fields.flatMap((field): FormEvent[] => {
    const value = sample(field, variant);
    return value === undefined ? [] : [{ type: 'answer', field: field.id, value }];
  });
  return apply(form, apply(form, {}, events), events);
}

/** `fillAll('first')`, plus `count` entries in each repeating section with the first filled. */
function withEntries(form: CompiledForm, count = 2): Answers {
  const answers: Record<string, unknown> = Object.fromEntries(
    Object.entries(fillAll(form, 'first')).filter(
      ([key]) => form.elements.get(key)?.repeat === undefined,
    ),
  );
  const events: FormEvent[] = [];
  for (const section of form.definition.pages.flatMap((page) => page.sections)) {
    const repeat = section.repeat;
    if (repeat === undefined) {
      continue;
    }
    const ids = Array.from(
      { length: Math.min(count, repeat.maxEntries) },
      (_, index) => `${section.id}-${String(index + 1)}`,
    );
    answers[section.id] = ids.map((id) => ({ id, values: {} }));
    const first = ids[0];
    if (first === undefined) {
      continue;
    }
    for (const field of section.fields.filter(isQuestion)) {
      const value = sample(field, 'first');
      if (value !== undefined) {
        events.push({ type: 'answer', field: field.id, value, entry: first });
      }
    }
  }
  return apply(form, answers, events);
}

const MEDIA = {
  mediaId: '00000000-0000-4000-8000-000000000001',
  contentType: 'image/jpeg',
  byteSize: 120_000,
};

/** A value for a question: a plain valid one (`first`), or one most rules refuse (`last`). */
function sample(field: Field, variant: Variant): unknown {
  const first = variant === 'first';
  if ('calculation' in field && field.calculation !== undefined) {
    return undefined;
  }
  if (field.readOnly === true) {
    return undefined;
  }
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'barcode':
      return first ? 'ABC123' : 'x';
    case 'number':
      return first ? (field.min ?? 1) : field.max === undefined ? -5 : field.max + 1;
    case 'decimal':
      return first
        ? (field.min ?? '1')
        : field.max === undefined
          ? '-5'
          : `${field.max.split('.')[0] ?? '0'}000`;
    case 'date':
      return first ? '2026-09-01' : '1999-12-31';
    case 'time':
      return first ? '09:30' : '23:59';
    case 'datetime':
      return first ? '2026-09-01T09:30:00+03:00' : '1999-12-31T23:59:00+03:00';
    case 'dropdown':
    case 'radio':
      return (first ? field.options[0] : field.options.at(-1))?.value;
    case 'multi_select':
      return first
        ? field.options.slice(0, 1).map((option) => option.value)
        : field.options.map((option) => option.value);
    case 'checkbox':
      return first;
    case 'yes_no':
      return first ? 'yes' : 'no';
    case 'rating':
      return first ? field.scale : 1;
    case 'signature':
      return { ...MEDIA, contentType: 'image/png' };
    case 'photo':
      return first ? [MEDIA] : [];
    case 'file':
      return [
        {
          ...MEDIA,
          contentType: field.acceptedTypes?.[0]?.replace('*', 'png') ?? 'application/pdf',
        },
      ];
    case 'gps':
      return { latitude: '30.0444', longitude: '31.2357', accuracyMeters: '5' };
  }
}
