import type { CompiledForm } from './compile.js';
import { type Answers, type EvaluationContext, ownAnswer } from './evaluate.js';
import { type FieldError, hasAnswerShape, isAnswered, isCalculated } from './field-types.js';
import type { ElementId } from './ids.js';
import { validateForm } from './validation.js';

/**
 * A form being filled in, as a pure state machine.
 *
 *   editing ──submit (valid)──▶ submitted ──reopen──▶ editing
 *      ▲  │
 *      └──┘ answer · clear · touch · submit (invalid)
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
 */

export type FormStatus = 'editing' | 'submitted';

export interface FormState {
  readonly status: FormStatus;
  readonly answers: Answers;
  /** Fields the person has visited and left, in the order they first did. */
  readonly touched: readonly ElementId[];
  readonly submitAttempted: boolean;
}

export type FormEvent =
  | { type: 'answer'; field: ElementId; value: unknown }
  | { type: 'clear'; field: ElementId }
  | { type: 'touch'; field: ElementId }
  | { type: 'submit' }
  | { type: 'reopen' };

export type RejectionReason =
  | 'unknown_field'
  | 'read_only'
  | 'calculated'
  | 'wrong_shape'
  | 'not_editing'
  | 'not_submitted'
  | 'invalid';

export type Transition =
  | { accepted: true; state: FormState }
  | { accepted: false; state: FormState; reason: RejectionReason };

/**
 * A fresh form, with defaults filled in wherever no answer was given.
 *
 * `answers` is how a draft is resumed — on another device, or after the app was
 * killed — so defaults never overwrite something already there.
 */
export function createFormState(form: CompiledForm, answers: Answers = {}): FormState {
  const withDefaults: Record<string, unknown> = { ...answers };
  for (const field of form.fields) {
    if (
      !isCalculated(field) &&
      'default' in field &&
      field.default !== undefined &&
      ownAnswer(withDefaults, field.id) === undefined
    ) {
      withDefaults[field.id] = field.default;
    }
  }
  return { status: 'editing', answers: withDefaults, touched: [], submitAttempted: false };
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

  switch (event.type) {
    case 'reopen':
      return state.status === 'submitted'
        ? { accepted: true, state: { ...state, status: 'editing' } }
        : refuse('not_submitted');

    case 'submit': {
      if (state.status !== 'editing') {
        return refuse('not_editing');
      }
      // Trying to submit is what turns on every error message, including for
      // fields never visited. That happens whether or not the submit succeeds.
      const attempted = { ...state, submitAttempted: true };
      return validateForm(form, state.answers, context).valid
        ? { accepted: true, state: { ...attempted, status: 'submitted' } }
        : refuse('invalid', attempted);
    }

    case 'answer':
    case 'clear':
    case 'touch': {
      if (state.status !== 'editing') {
        return refuse('not_editing');
      }
      const field = form.elements.get(event.field)?.field;
      if (field === undefined) {
        return refuse('unknown_field');
      }

      if (event.type === 'touch') {
        return {
          accepted: true,
          state: state.touched.includes(field.id)
            ? state
            : { ...state, touched: [...state.touched, field.id] },
        };
      }

      if (isCalculated(field)) {
        return refuse('calculated');
      }
      if (field.readOnly === true) {
        return refuse('read_only');
      }

      const answers: Record<string, unknown> = { ...state.answers };
      if (event.type === 'clear' || !isAnswered(field, event.value)) {
        // An empty string or an empty selection is a cleared answer, stored as
        // absent, so "answered" means one thing everywhere.
        delete answers[field.id];
      } else if (!hasAnswerShape(field, event.value)) {
        return refuse('wrong_shape');
      } else {
        answers[field.id] = event.value;
      }
      return { accepted: true, state: { ...state, answers } };
    }
  }
}

export interface FormProgress {
  /** Visible required fields that are satisfied. */
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
  readonly errors: readonly FieldError[];
  /**
   * The errors to show right now: on fields the person has left, or on every
   * field once they have tried to submit. Nobody wants "required" in red on a
   * form they opened a second ago.
   */
  readonly shownErrors: readonly FieldError[];
  readonly valid: boolean;
  readonly progress: FormProgress;
}

export function viewForm(
  form: CompiledForm,
  state: FormState,
  context: EvaluationContext = {},
): FormView {
  const validation = validateForm(form, state.answers, context);
  const { visible, values } = validation.evaluation;

  let requiredAnswered = 0;
  let requiredTotal = 0;
  let answered = 0;
  let total = 0;
  const failing = new Set(
    validation.errors.filter((error) => error.code === 'required').map((error) => error.field),
  );

  for (const field of form.fields) {
    if (visible.get(field.id) !== true || isCalculated(field)) {
      continue;
    }
    total += 1;
    if (isAnswered(field, values.get(field.id))) {
      answered += 1;
    }
    if (field.required === true) {
      requiredTotal += 1;
      if (!failing.has(field.id)) {
        requiredAnswered += 1;
      }
    }
  }

  const shownErrors = state.submitAttempted
    ? validation.errors
    : validation.errors.filter((error) => state.touched.includes(error.field));

  return {
    status: state.status,
    visible,
    values,
    errors: validation.errors,
    shownErrors,
    valid: validation.valid,
    progress: { requiredAnswered, requiredTotal, answered, total },
  };
}

/**
 * What to send: visible answers and calculated values, nothing typed into a
 * field that has since been hidden.
 */
export function toSubmission(
  form: CompiledForm,
  state: FormState,
  context: EvaluationContext = {},
): Record<ElementId, unknown> {
  const { values } = validateForm(form, state.answers, context).evaluation;
  const submission: Record<ElementId, unknown> = {};
  for (const field of form.fields) {
    if (values.has(field.id) && !isCalculated(field)) {
      submission[field.id] = values.get(field.id);
    }
  }
  return submission;
}
