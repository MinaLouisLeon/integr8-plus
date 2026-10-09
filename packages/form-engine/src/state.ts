import type { AvailableOptions } from './choices.js';
import type { CompiledForm } from './compile.js';
import { ENTRY_ID, type Entry } from './definition.js';
import { type Answers, type EvaluationContext, ownAnswer, storedEntries } from './evaluate.js';
import {
  type Field,
  type FieldError,
  hasAnswerShape,
  isAnswered,
  isCalculated,
} from './field-types.js';
import type { ElementId } from './ids.js';
import { answerKey, validateForm } from './validation.js';

/**
 * A form being filled in, as a pure state machine.
 *
 *   editing ──submit (valid)──▶ submitted ──reopen──▶ editing
 *      ▲  │
 *      └──┘ answer · clear · touch · add, remove or move an entry · submit (invalid)
 *
 * State holds only what a person did: the answers they gave, which fields they
 * have left, and whether they have tried to submit. Everything else —
 * visibility, calculated values, errors, progress — is *derived* from that and
 * the compiled form, every time, by `viewForm`. Nothing derived is stored, so
 * nothing derived can go stale, and a renderer on any platform gets the same
 * view from the same state.
 *
 * Transitions never throw. A refused event returns the reason alongside the
 * state, so a renderer can decide what to show without a try block.
 *
 * The engine never makes up an entry's id: whoever adds an entry supplies one,
 * so the same events give the same state on every device.
 */

export type FormStatus = 'editing' | 'submitted';

export interface FormState {
  readonly status: FormStatus;
  readonly answers: Answers;
  /**
   * Fields the person has visited and left, in the order they first did, by
   * `touchKey`: a field's id, or for an entry's field, the entry and the field.
   */
  readonly touched: readonly string[];
  readonly submitAttempted: boolean;
}

export type FormEvent =
  | { type: 'answer'; field: ElementId; value: unknown; entry?: string }
  | { type: 'clear'; field: ElementId; entry?: string }
  | { type: 'touch'; field: ElementId; entry?: string }
  | { type: 'add_entry'; section: ElementId; entry: string; index?: number }
  | { type: 'remove_entry'; section: ElementId; entry: string }
  | { type: 'move_entry'; section: ElementId; entry: string; index: number }
  | { type: 'submit' }
  | { type: 'reopen' };

export type RejectionReason =
  | 'unknown_field'
  | 'read_only'
  | 'calculated'
  | 'wrong_shape'
  | 'not_editing'
  | 'not_submitted'
  | 'invalid'
  /** The section does not repeat. */
  | 'not_repeatable'
  /** No entry of the section has this id, or the field is not asked per entry. */
  | 'unknown_entry'
  /** The field is asked once per entry, and the event did not say which. */
  | 'entry_needed'
  /** The id is not a well-formed entry id, or another entry already has it. */
  | 'invalid_entry_id'
  | 'too_many_entries';

export type Transition =
  | { accepted: true; state: FormState }
  | { accepted: false; state: FormState; reason: RejectionReason };

/** How `touched`, `required` and `availableOptions` name a field, or one entry's field. */
export function touchKey(field: ElementId, entry?: string): string {
  return answerKey(field, entry);
}

export interface FormStateOptions {
  /**
   * Makes an id for an entry the engine adds itself: a repeatable section that
   * needs entries opens with that many. Without it, none are added.
   */
  newEntryId?: () => string;
}

/** Defaults for a set of fields, where nothing is already there. */
function withDefaults(fields: readonly Field[], answers: Answers): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...answers };
  for (const field of fields) {
    if (
      !isCalculated(field) &&
      'default' in field &&
      field.default !== undefined &&
      ownAnswer(filled, field.id) === undefined
    ) {
      filled[field.id] = field.default;
    }
  }
  return filled;
}

function fieldsOfSection(form: CompiledForm, section: ElementId): Field[] {
  return form.fields.filter((field) => form.elements.get(field.id)?.entries === section);
}

/**
 * A fresh form, with defaults filled in wherever no answer was given — in every
 * entry too.
 *
 * `answers` is how a draft is resumed — on another device, or after the app was
 * killed — so defaults never overwrite something already there.
 */
export function createFormState(
  form: CompiledForm,
  answers: Answers = {},
  options: FormStateOptions = {},
): FormState {
  const topLevel = form.fields.filter(
    (field) => form.elements.get(field.id)?.entries === undefined,
  );
  const filled = withDefaults(topLevel, answers);

  for (const element of form.elements.values()) {
    if (element.repeat === undefined) {
      continue;
    }
    const fields = fieldsOfSection(form, element.id);
    const stored = ownAnswer(filled, element.id);
    let entries: Entry[] | undefined = Array.isArray(stored)
      ? storedEntries(filled, element.id).map((entry) => ({
          id: entry.id,
          values: withDefaults(fields, entry.values),
        }))
      : undefined;
    // A list that is not all entries is left as it is, for validation to name.
    if (Array.isArray(stored) && entries !== undefined && entries.length !== stored.length) {
      entries = undefined;
    }
    const needed = element.repeat.minEntries ?? 0;
    if (options.newEntryId !== undefined && stored === undefined && needed > 0) {
      entries = Array.from({ length: needed }, () => ({
        id: options.newEntryId!(),
        values: withDefaults(fields, {}),
      }));
    }
    if (entries !== undefined && entries.length > 0) {
      filled[element.id] = entries;
    }
  }

  return { status: 'editing', answers: filled, touched: [], submitAttempted: false };
}

export function transition(
  form: CompiledForm,
  state: FormState,
  event: FormEvent,
  context: EvaluationContext = {},
): Transition {
  const refuse = (reason: RejectionReason, next: FormState = state): Transition => ({
    accepted: false,
    state: next,
    reason,
  });
  const accept = (next: FormState): Transition => ({ accepted: true, state: next });

  switch (event.type) {
    case 'reopen':
      return state.status === 'submitted'
        ? accept({ ...state, status: 'editing' })
        : refuse('not_submitted');

    case 'submit': {
      if (state.status !== 'editing') {
        return refuse('not_editing');
      }
      // Trying to submit is what turns on every error message, including for
      // fields never visited. That happens whether or not the submit succeeds.
      const attempted = { ...state, submitAttempted: true };
      return validateForm(form, state.answers, context).valid
        ? accept({ ...attempted, status: 'submitted' })
        : refuse('invalid', attempted);
    }

    case 'add_entry':
    case 'remove_entry':
    case 'move_entry': {
      if (state.status !== 'editing') {
        return refuse('not_editing');
      }
      const section = form.elements.get(event.section);
      if (section?.repeat === undefined) {
        return refuse('not_repeatable');
      }
      const entries = storedEntries(state.answers, section.id);
      const at = entries.findIndex((entry) => entry.id === event.entry);
      const answers: Record<string, unknown> = { ...state.answers };

      if (event.type === 'add_entry') {
        if (!ENTRY_ID.test(event.entry) || at !== -1) {
          return refuse('invalid_entry_id');
        }
        if (entries.length >= section.repeat.maxEntries) {
          return refuse('too_many_entries');
        }
        const next = [...entries];
        const index = Math.max(0, Math.min(event.index ?? next.length, next.length));
        next.splice(index, 0, {
          id: event.entry,
          values: withDefaults(fieldsOfSection(form, section.id), {}),
        });
        answers[section.id] = next;
        return accept({ ...state, answers });
      }

      if (at === -1) {
        return refuse('unknown_entry');
      }
      const next = [...entries];
      const [moved] = next.splice(at, 1);
      if (event.type === 'move_entry') {
        next.splice(Math.max(0, Math.min(event.index, next.length)), 0, moved!);
      }
      if (next.length === 0) {
        // No entries is no answer, stored as absent, like an empty selection.
        delete answers[section.id];
      } else {
        answers[section.id] = next;
      }
      const prefix = `${event.entry}/`;
      return accept({
        ...state,
        answers,
        touched:
          event.type === 'remove_entry'
            ? state.touched.filter((key) => !key.startsWith(prefix))
            : state.touched,
      });
    }

    case 'answer':
    case 'clear':
    case 'touch': {
      if (state.status !== 'editing') {
        return refuse('not_editing');
      }
      const element = form.elements.get(event.field);
      const field = element?.field;
      if (field === undefined) {
        return refuse('unknown_field');
      }
      const section = element?.entries;
      if (section === undefined && event.entry !== undefined) {
        return refuse('unknown_entry');
      }
      if (section !== undefined && event.entry === undefined) {
        return refuse('entry_needed');
      }
      const entries = section === undefined ? [] : storedEntries(state.answers, section);
      const at = entries.findIndex((entry) => entry.id === event.entry);
      if (section !== undefined && at === -1) {
        return refuse('unknown_entry');
      }

      if (event.type === 'touch') {
        const key = touchKey(field.id, event.entry);
        return accept(
          state.touched.includes(key) ? state : { ...state, touched: [...state.touched, key] },
        );
      }

      if (isCalculated(field)) {
        return refuse('calculated');
      }
      if (field.readOnly === true) {
        return refuse('read_only');
      }

      const values: Record<string, unknown> = {
        ...(section === undefined ? state.answers : entries[at]!.values),
      };
      if (event.type === 'clear' || !isAnswered(field, event.value)) {
        // An empty string or an empty selection is a cleared answer, stored as
        // absent, so "answered" means one thing everywhere.
        delete values[field.id];
      } else if (!hasAnswerShape(field, event.value)) {
        return refuse('wrong_shape');
      } else {
        values[field.id] = event.value;
      }

      if (section === undefined) {
        return accept({ ...state, answers: values });
      }
      const next = [...entries];
      next[at] = { id: entries[at]!.id, values };
      return accept({ ...state, answers: { ...state.answers, [section]: next } });
    }
  }
}

export interface FormProgress {
  /** Visible required fields that are satisfied, each entry's counted once per entry. */
  readonly requiredAnswered: number;
  readonly requiredTotal: number;
  /** Visible typed fields with an answer. */
  readonly answered: number;
  readonly total: number;
}

export interface FormView {
  readonly status: FormStatus;
  readonly visible: ReadonlyMap<ElementId, boolean>;
  /** Effective values, calculated ones included. Hidden fields are absent. */
  readonly values: ReadonlyMap<ElementId, unknown>;
  /** Each repeatable section's entries, worked out. */
  readonly entries: FormValidationEntries;
  readonly errors: readonly FieldError[];
  /**
   * The errors to show right now: on fields the person has left, or on every
   * field once they have tried to submit. Nobody wants "required" in red on a
   * form they opened a second ago.
   */
  readonly shownErrors: readonly FieldError[];
  readonly valid: boolean;
  readonly progress: FormProgress;
  /**
   * Whether each visible typed field must be answered right now, by `touchKey`:
   * `required`, or `requiredWhen` definitely true. A renderer shows the mark
   * from this, so it follows the answers rather than the definition.
   */
  readonly required: ReadonlyMap<string, boolean>;
  /**
   * For each visible choice field whose options depend on another answer, what
   * it offers right now, by `touchKey`. A field that depends on nothing is
   * absent, and offers every option.
   */
  readonly availableOptions: ReadonlyMap<string, AvailableOptions>;
}

type FormValidationEntries = ReturnType<typeof validateForm>['evaluation']['entries'];

export function viewForm(
  form: CompiledForm,
  state: FormState,
  context: EvaluationContext = {},
): FormView {
  const validation = validateForm(form, state.answers, context);
  const { visible, values, entries } = validation.evaluation;

  let requiredAnswered = 0;
  let requiredTotal = 0;
  let answered = 0;
  let total = 0;
  const failing = new Set(
    validation.errors
      .filter((error) => error.code === 'required')
      .map((error) => touchKey(error.field, error.entry)),
  );

  const count = (field: Field, value: unknown, shown: boolean, entry: string | undefined) => {
    if (!shown || isCalculated(field)) {
      return;
    }
    total += 1;
    if (isAnswered(field, value)) {
      answered += 1;
    }
    if (validation.required.get(touchKey(field.id, entry)) === true) {
      requiredTotal += 1;
      if (!failing.has(touchKey(field.id, entry))) {
        requiredAnswered += 1;
      }
    }
  };

  for (const field of form.fields) {
    const section = form.elements.get(field.id)?.entries;
    if (section === undefined) {
      count(field, values.get(field.id), visible.get(field.id) === true, undefined);
      continue;
    }
    for (const entry of entries.get(section) ?? []) {
      count(field, entry.values.get(field.id), entry.visible.get(field.id) === true, entry.id);
    }
  }
  // A section still short of the entries it needs is one thing left to do.
  for (const error of validation.errors) {
    if (error.code === 'too_few_entries') {
      requiredTotal += 1;
      total += 1;
    }
  }

  const shownErrors = state.submitAttempted
    ? validation.errors
    : validation.errors.filter((error) =>
        state.touched.includes(touchKey(error.field, error.entry)),
      );

  return {
    status: state.status,
    visible,
    values,
    entries,
    errors: validation.errors,
    shownErrors,
    valid: validation.valid,
    progress: { requiredAnswered, requiredTotal, answered, total },
    required: validation.required,
    availableOptions: validation.availableOptions,
  };
}

/**
 * What to send: visible answers and calculated values, nothing typed into a
 * field that has since been hidden — in entries, too, without their calculated
 * values.
 */
export function toSubmission(
  form: CompiledForm,
  state: FormState,
  context: EvaluationContext = {},
): Record<ElementId, unknown> {
  const { values } = validateForm(form, state.answers, context).evaluation;
  const submission: Record<ElementId, unknown> = {};
  const elements = [...form.elements.values()].sort((a, b) => a.index - b.index);
  for (const element of elements) {
    if (element.repeat !== undefined) {
      const worked = values.get(element.id) as Entry[] | undefined;
      if (worked !== undefined) {
        submission[element.id] = worked.map((entry) => ({
          id: entry.id,
          values: Object.fromEntries(
            Object.entries(entry.values).filter(([id]) => {
              const field = form.elements.get(id)?.field;
              return field !== undefined && !isCalculated(field);
            }),
          ),
        }));
      }
      continue;
    }
    const field = element.field;
    if (field !== undefined && values.has(field.id) && !isCalculated(field)) {
      submission[field.id] = values.get(field.id);
    }
  }
  return submission;
}
