import type { CompiledForm } from './compile.js';
import {
  type Answers,
  type EvaluationContext,
  evaluateExpression,
  evaluateForm,
  type FormEvaluation,
  toRuleValue,
  truth,
} from './evaluate.js';
import { type FieldError, isAnswered, isCalculated, validateAnswer } from './field-types.js';
import type { ElementId } from './ids.js';

/**
 * Validity: what is wrong with a set of answers, field by field.
 *
 * The same function runs on the phone as a person types, and on the server when
 * the submission arrives (P08). The phone's result is for speed; the server's is
 * for truth. That only works because they are the same function over the same
 * compiled form, and the conformance suite is what proves they agree.
 *
 * Only **visible** fields are validated. A required field inside a section that
 * is hidden is not missing — it is not part of the form as this person sees it.
 */

export interface FormValidation {
  readonly evaluation: FormEvaluation;
  /** In definition order; within a field, shape and range before custom rules. */
  readonly errors: readonly FieldError[];
  readonly valid: boolean;
}

export function validateForm(
  form: CompiledForm,
  answers: Answers,
  context: EvaluationContext = {},
): FormValidation {
  const evaluation = evaluateForm(form, answers, context);
  const errors: FieldError[] = [];

  const scope = {
    value: (id: ElementId) => {
      const field = form.elements.get(id)?.field;
      return field === undefined || !evaluation.values.has(id)
        ? undefined
        : toRuleValue(field, evaluation.values.get(id));
    },
    context,
  };

  for (const field of form.fields) {
    if (evaluation.visible.get(field.id) !== true) {
      continue;
    }

    // A calculated value is the engine's own output. It has no author to tell.
    if (isCalculated(field)) {
      continue;
    }

    const value = evaluation.values.get(field.id);
    if (!isAnswered(field, value)) {
      if (field.required === true) {
        errors.push({ field: field.id, code: 'required', params: {} });
      }
    } else if (field.type === 'checkbox' && field.required === true && value !== true) {
      // On a checkbox, "required" means ticked: "I have isolated the supply."
      errors.push({ field: field.id, code: 'required', params: {} });
    } else {
      errors.push(...validateAnswer(field, value));
    }

    for (const rule of field.rules ?? []) {
      if (truth(evaluateExpression(rule.assert, scope)) === false) {
        errors.push({ field: field.id, code: 'rule_failed', params: { rule: rule.id } });
      }
    }
  }

  return { evaluation, errors, valid: errors.length === 0 };
}

// ---------------------------------------------------------------------------
// A submission, as the server receives it
// ---------------------------------------------------------------------------

export const SUBMISSION_ISSUE_CODES = [
  'not_an_object',
  'unknown_field',
  'answer_to_hidden_field',
  'answer_to_calculated_field',
] as const;

export type SubmissionIssueCode = (typeof SUBMISSION_ISSUE_CODES)[number];

export interface SubmissionIssue {
  code: SubmissionIssueCode;
  field: string | undefined;
}

export interface SubmissionCheck {
  readonly valid: boolean;
  /** Problems with the submission as a whole — keys that should not be there. */
  readonly issues: readonly SubmissionIssue[];
  readonly errors: readonly FieldError[];
  /**
   * The answers to store: what was sent for visible typed fields, and the
   * server's own result for calculated ones. Only meaningful when `valid`.
   */
  readonly answers: Readonly<Record<ElementId, unknown>>;
}

/**
 * Stricter than `validateForm`, because it is judging something a client sent.
 *
 * - **A key the form does not have** is refused. A renamed field in a stale
 *   client, or a hand-crafted request, should not be stored as though it meant
 *   something.
 * - **An answer to a hidden field** is refused. The engine never produces one —
 *   `toSubmission` strips them — so its presence means the client disagrees
 *   with the server about what is visible, which is the disagreement this whole
 *   package exists to prevent.
 * - **A value for a calculated field** is refused. The server works it out
 *   itself; accepting the client's would let a client decide a total.
 */
export function validateSubmission(
  form: CompiledForm,
  submitted: unknown,
  context: EvaluationContext = {},
): SubmissionCheck {
  if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) {
    return {
      valid: false,
      issues: [{ code: 'not_an_object', field: undefined }],
      errors: [],
      answers: {},
    };
  }

  const answers = submitted as Record<string, unknown>;
  const validation = validateForm(form, answers, context);
  const issues: SubmissionIssue[] = [];

  for (const key of Object.keys(answers).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const field = form.elements.get(key)?.field;
    if (field === undefined) {
      issues.push({ code: 'unknown_field', field: key });
    } else if (isCalculated(field)) {
      issues.push({ code: 'answer_to_calculated_field', field: key });
    } else if (validation.evaluation.visible.get(key) !== true) {
      issues.push({ code: 'answer_to_hidden_field', field: key });
    }
  }

  return {
    valid: issues.length === 0 && validation.valid,
    issues,
    errors: validation.errors,
    answers: Object.fromEntries(validation.evaluation.values),
  };
}
