import type { CompiledForm, ElementInfo } from './compile.js';
import { entriesSchema } from './definition.js';
import {
  type Answers,
  type EvaluationContext,
  evaluateExpression,
  evaluateForm,
  evaluationScope,
  type FormEvaluation,
  ownAnswer,
  type Scope,
  storedEntries,
  truth,
} from './evaluate.js';
import {
  type Field,
  type FieldError,
  hasAnswerShape,
  isAnswered,
  isCalculated,
  validateAnswer,
} from './field-types.js';
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
 *
 * A repeatable section is checked where it sits: first whether it has too few
 * or too many entries, then each entry's fields in turn, each error naming its
 * entry (P13b).
 */

export interface FormValidation {
  readonly evaluation: FormEvaluation;
  /**
   * In definition order; within a field, shape and range before custom rules.
   * A repeatable section's errors come entry by entry, after its own.
   */
  readonly errors: readonly FieldError[];
  readonly valid: boolean;
}

/** The elements in reading order, each once. */
function inReadingOrder(form: CompiledForm): ElementInfo[] {
  return [...form.elements.values()].sort((a, b) => a.index - b.index);
}

export function validateForm(
  form: CompiledForm,
  answers: Answers,
  context: EvaluationContext = {},
): FormValidation {
  const evaluation = evaluateForm(form, answers, context);
  const errors: FieldError[] = [];
  const scope = evaluationScope(form, evaluation, context);

  const check = (
    field: Field,
    value: unknown,
    within: Scope,
    entry: string | undefined,
  ): FieldError[] => {
    const found: FieldError[] = [];
    const push = (error: FieldError) => {
      found.push(entry === undefined ? error : { ...error, entry });
    };
    if (!isAnswered(field, value)) {
      if (field.required === true) {
        push({ field: field.id, code: 'required', params: {} });
      }
    } else if (field.type === 'checkbox' && field.required === true && value !== true) {
      // On a checkbox, "required" means ticked: "I have isolated the supply."
      push({ field: field.id, code: 'required', params: {} });
    } else {
      validateAnswer(field, value).forEach(push);
    }

    for (const rule of field.rules ?? []) {
      if (truth(evaluateExpression(rule.assert, within)) === false) {
        push({ field: field.id, code: 'rule_failed', params: { rule: rule.id } });
      }
    }
    return found;
  };

  const elements = inReadingOrder(form);
  for (const element of elements) {
    if (element.repeat !== undefined) {
      if (evaluation.visible.get(element.id) !== true) {
        continue;
      }
      const entries = evaluation.entries.get(element.id) ?? [];
      const { minEntries, maxEntries } = element.repeat;
      if (minEntries !== undefined && entries.length < minEntries) {
        errors.push({
          field: element.id,
          code: 'too_few_entries',
          params: { minimum: String(minEntries) },
        });
      }
      if (entries.length > maxEntries) {
        errors.push({
          field: element.id,
          code: 'too_many_entries',
          params: { maximum: String(maxEntries) },
        });
      }
      const fields = elements.filter((candidate) => candidate.entries === element.id);
      const scopes = scope.entries(element.id);
      entries.forEach((entry, index) => {
        for (const inner of fields) {
          // A calculated value is the engine's own output. It has no author to tell.
          if (
            inner.field === undefined ||
            entry.visible.get(inner.id) !== true ||
            isCalculated(inner.field)
          ) {
            continue;
          }
          errors.push(...check(inner.field, entry.values.get(inner.id), scopes[index]!, entry.id));
        }
      });
      continue;
    }

    const field = element.field;
    if (
      field === undefined ||
      element.entries !== undefined ||
      evaluation.visible.get(field.id) !== true ||
      isCalculated(field)
    ) {
      continue;
    }
    errors.push(...check(field, evaluation.values.get(field.id), scope, undefined));
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
  'duplicate_entry',
] as const;

export type SubmissionIssueCode = (typeof SUBMISSION_ISSUE_CODES)[number];

export interface SubmissionIssue {
  code: SubmissionIssueCode;
  field: string | undefined;
  /** For a key inside an entry of a repeatable section: that entry's id. */
  entry?: string;
  /** For a key inside an entry: the repeatable section the entry belongs to. */
  section?: string;
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

const sortedKeys = (value: object) =>
  Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Stricter than `validateForm`, because it is judging something a client sent.
 *
 * - **A key the form does not have** is refused. A renamed field in a stale
 *   client, or a hand-crafted request, should not be stored as though it meant
 *   something. A field of a repeatable section is not a key of its own: its
 *   answers belong inside the section's entries.
 * - **An answer to a hidden field** is refused. The engine never produces one —
 *   `toSubmission` strips them — so its presence means the client disagrees
 *   with the server about what is visible, which is the disagreement this whole
 *   package exists to prevent.
 * - **A value for a calculated field** is refused. The server works it out
 *   itself; accepting the client's would let a client decide a total.
 * - **An answer of the wrong shape** is refused as `invalid`. Evaluation treats
 *   a malformed answer as no answer, which is right while someone is typing and
 *   wrong here: a number sent for a decimal would otherwise be dropped without a
 *   word, and the submission stored without it. Entries that are not a list of
 *   `{ id, values }` are `invalid` on the section; two entries with one id are
 *   refused as `duplicate_entry`.
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
  /** Malformed answers, by field and entry: `invalid` replaces what validation said. */
  const malformed = new Map<string, { field: ElementId; entry: string | undefined }>();
  const key = (field: ElementId, entry: string | undefined) =>
    entry === undefined ? field : `${entry}/${field}`;

  for (const name of sortedKeys(answers)) {
    const element = form.elements.get(name);
    if (element?.repeat !== undefined) {
      if (validation.evaluation.visible.get(name) !== true) {
        issues.push({ code: 'answer_to_hidden_field', field: name });
        continue;
      }
      checkEntries(form, element, ownAnswer(answers, name), validation, issues, (field, entry) =>
        malformed.set(key(field, entry), { field, entry }),
      );
      continue;
    }
    const field = element?.field;
    if (field === undefined || element?.entries !== undefined) {
      issues.push({ code: 'unknown_field', field: name });
    } else if (isCalculated(field)) {
      issues.push({ code: 'answer_to_calculated_field', field: name });
    } else if (validation.evaluation.visible.get(name) !== true) {
      issues.push({ code: 'answer_to_hidden_field', field: name });
    }
  }

  for (const field of form.fields) {
    const element = form.elements.get(field.id);
    if (
      element?.entries === undefined &&
      !isCalculated(field) &&
      validation.evaluation.visible.get(field.id) === true &&
      Object.prototype.hasOwnProperty.call(answers, field.id) &&
      !hasAnswerShape(field, ownAnswer(answers, field.id))
    ) {
      malformed.set(field.id, { field: field.id, entry: undefined });
    }
  }

  const errors: FieldError[] = [];
  const replaced = new Set<string>();
  for (const error of validation.errors) {
    const at = key(error.field, error.entry);
    if (!malformed.has(at)) {
      errors.push(error);
    } else if (!replaced.has(at)) {
      replaced.add(at);
      errors.push({
        field: error.field,
        code: 'invalid',
        params: {},
        ...(error.entry === undefined ? {} : { entry: error.entry }),
      });
    }
  }
  // A malformed answer validation had nothing to say about — an optional field
  // it read as blank, a list of entries that is not a list — still gets its
  // `invalid`, where the field sits.
  const position = (field: ElementId, entry: string | undefined): number[] => {
    const element = form.elements.get(field);
    if (entry === undefined || element?.entries === undefined) {
      return [element?.index ?? 0, -1, 0];
    }
    const ordinal = (validation.evaluation.entries.get(element.entries) ?? []).findIndex(
      (candidate) => candidate.id === entry,
    );
    return [form.elements.get(element.entries)?.index ?? 0, ordinal, element.index];
  };
  const later = (a: readonly number[], b: readonly number[]) => {
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return a[index]! > b[index]!;
      }
    }
    return false;
  };
  for (const [at, place] of malformed) {
    if (replaced.has(at)) {
      continue;
    }
    const where = position(place.field, place.entry);
    const before = errors.findIndex((error) => later(position(error.field, error.entry), where));
    const invalid: FieldError = {
      field: place.field,
      code: 'invalid',
      params: {},
      ...(place.entry === undefined ? {} : { entry: place.entry }),
    };
    if (before === -1) {
      errors.push(invalid);
    } else {
      errors.splice(before, 0, invalid);
    }
  }

  return {
    valid: issues.length === 0 && errors.length === 0,
    issues,
    errors,
    answers: Object.fromEntries(validation.evaluation.values),
  };
}

function checkEntries(
  form: CompiledForm,
  section: ElementInfo,
  value: unknown,
  validation: FormValidation,
  issues: SubmissionIssue[],
  markMalformed: (field: ElementId, entry: string | undefined) => void,
): void {
  const parsed = entriesSchema.safeParse(value);
  if (!parsed.success) {
    markMalformed(section.id, undefined);
    return;
  }
  const seen = new Set<string>();
  const evaluated = new Map(
    (validation.evaluation.entries.get(section.id) ?? []).map((entry) => [entry.id, entry]),
  );
  for (const entry of parsed.data) {
    if (seen.has(entry.id)) {
      issues.push({ code: 'duplicate_entry', field: section.id, entry: entry.id });
      continue;
    }
    seen.add(entry.id);
    const worked = evaluated.get(entry.id);
    for (const name of sortedKeys(entry.values)) {
      const element = form.elements.get(name);
      const field = element?.field;
      if (field === undefined || element?.entries !== section.id) {
        issues.push({ code: 'unknown_field', field: name, entry: entry.id, section: section.id });
      } else if (isCalculated(field)) {
        issues.push({
          code: 'answer_to_calculated_field',
          field: name,
          entry: entry.id,
          section: section.id,
        });
      } else if (worked?.visible.get(name) !== true) {
        issues.push({
          code: 'answer_to_hidden_field',
          field: name,
          entry: entry.id,
          section: section.id,
        });
      } else if (!hasAnswerShape(field, ownAnswer(entry.values, name))) {
        markMalformed(name, entry.id);
      }
    }
  }
}

/** The answers stored for a repeatable section, as evaluation reads them. */
export { storedEntries };
