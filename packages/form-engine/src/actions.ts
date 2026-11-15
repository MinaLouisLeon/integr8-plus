import { z } from 'zod';
import { checkFormCondition, type CompiledForm } from './compile.js';
import { compareDecimal, formatDecimal, fromInteger, rescale, type Decimal } from './decimal.js';
import {
  evaluateExpression,
  evaluateForm,
  evaluationScope,
  toRuleValue,
  truth,
  type Answers,
  type EvaluationContext,
} from './evaluate.js';
import { expressionSchema, type Expression } from './expression.js';
import { describeFieldType } from './field-types.js';
import { elementIdSchema, localizedTextSchema, type LocalizedText } from './ids.js';

/**
 * Form actions (P40): what happens when a submission of a form version is
 * submitted. They sit beside the definition, not in it, so the definition's
 * format and its conformance corpus are unchanged; the server alone makes the
 * claims, and phones only learn which follow-up forms to open.
 *
 * This module is pure, like the rest of the engine: the schema, the checks that
 * need only the form, and the plan of what a submit would do. Checks that need
 * the company (a category exists, the follow-up form is published, the HR
 * module is on) are the API's.
 */

export const FORM_ACTION_KINDS = ['expense_claim', 'open_form'] as const;
export type FormActionKind = (typeof FORM_ACTION_KINDS)[number];

/** At most this many actions on one form version (the database agrees). */
export const MAX_FORM_ACTIONS = 10;

export const FORM_ACTION_ID = /^[a-z][a-z0-9_]{0,39}$/;

/** What a claim's description may name, filled at submit. */
export const FORM_ACTION_PLACEHOLDERS = [
  'job.reference',
  'job.title',
  'form.title',
  'submission.date',
] as const;
export type FormActionPlaceholder = (typeof FORM_ACTION_PLACEHOLDERS)[number];

const PLACEHOLDER = /\{\{\s*([a-z.]+)\s*\}\}/g;

export const formActionIdSchema = z
  .string()
  .regex(FORM_ACTION_ID, 'Use lowercase letters, digits and underscores, starting with a letter');

export const expenseClaimActionSchema = z.strictObject({
  id: formActionIdSchema,
  kind: z.literal('expense_claim'),
  /** Made only when this holds on the submitted answers. Left out: always. */
  when: expressionSchema.optional(),
  /** The company's expense category, by name (matched ignoring case). */
  category: z.string().trim().min(1).max(200),
  /** A number question or calculation of the form, at its top level. */
  amount: z.strictObject({ field: elementIdSchema }),
  /** The claim's description, with placeholders such as `{{job.reference}}`. */
  description: localizedTextSchema,
});

export const openFormActionSchema = z.strictObject({
  id: formActionIdSchema,
  kind: z.literal('open_form'),
  when: expressionSchema.optional(),
  /** The form to open next, for the same job: its id in the company. */
  form: z.uuid(),
  /** A required follow-up must be submitted before the job is completed. */
  required: z.boolean(),
});

export const formActionSchema = z.discriminatedUnion('kind', [
  expenseClaimActionSchema,
  openFormActionSchema,
]);

export const formActionsSchema = z.array(formActionSchema).max(MAX_FORM_ACTIONS);

export type ExpenseClaimAction = z.infer<typeof expenseClaimActionSchema>;
export type OpenFormAction = z.infer<typeof openFormActionSchema>;
export type FormAction = z.infer<typeof formActionSchema>;

export const FORM_ACTION_ISSUE_CODES = [
  'invalid_actions',
  'duplicate_action_id',
  'unknown_field',
  'not_a_number',
  'inside_repeat',
  'invalid_condition',
  'unknown_placeholder',
  'opens_itself',
] as const;
export type FormActionIssueCode = (typeof FORM_ACTION_ISSUE_CODES)[number];

export interface FormActionIssue {
  code: FormActionIssueCode;
  /** For the person publishing. The builder maps `code` to its own copy. */
  message: string;
  /** Where in the actions, e.g. `[1].amount.field`. */
  path: string;
  /** The action involved, when one is. */
  action?: string;
}

export type FormActionsCheck =
  { ok: true; actions: FormAction[] } | { ok: false; issues: FormActionIssue[] };

/**
 * Checks actions against the form they belong to. `formId` is that form's id,
 * so an action cannot open the form it is on.
 */
export function checkFormActions(
  input: unknown,
  form: CompiledForm,
  options: { formId?: string } = {},
): FormActionsCheck {
  const parsed = formActionsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid_actions',
        message: issue.message,
        path: issue.path
          .map((part) => (typeof part === 'number' ? `[${String(part)}]` : `.${String(part)}`))
          .join(''),
      })),
    };
  }

  const issues: FormActionIssue[] = [];
  const seen = new Set<string>();
  parsed.data.forEach((action, index) => {
    const at = `[${String(index)}]`;
    if (seen.has(action.id)) {
      issues.push({
        code: 'duplicate_action_id',
        message: `Two actions are called "${action.id}"`,
        path: `${at}.id`,
        action: action.id,
      });
    }
    seen.add(action.id);

    if (action.when !== undefined) {
      for (const issue of checkFormCondition(form, action.when, `${at}.when`, action.id)) {
        issues.push({
          code: issue.code === 'inside_repeat' ? 'inside_repeat' : 'invalid_condition',
          message: issue.message,
          path: issue.path,
          action: action.id,
        });
      }
    }

    if (action.kind === 'expense_claim') {
      const element = form.elements.get(action.amount.field);
      const field = element?.field;
      if (element === undefined || field === undefined) {
        issues.push({
          code: 'unknown_field',
          message: `The amount of "${action.id}" names "${action.amount.field}", which is not a question of this form`,
          path: `${at}.amount.field`,
          action: action.id,
        });
      } else if (describeFieldType(field.type).valueType !== 'number') {
        issues.push({
          code: 'not_a_number',
          message: `The amount of "${action.id}" must be a number question or calculation; "${action.amount.field}" is not`,
          path: `${at}.amount.field`,
          action: action.id,
        });
      } else if (element.entries !== undefined) {
        issues.push({
          code: 'inside_repeat',
          message: `The amount of "${action.id}" is inside a repeating section; use a total outside it`,
          path: `${at}.amount.field`,
          action: action.id,
        });
      }
      for (const [locale, text] of Object.entries(action.description)) {
        for (const name of placeholdersOf(text)) {
          if (!(FORM_ACTION_PLACEHOLDERS as readonly string[]).includes(name)) {
            issues.push({
              code: 'unknown_placeholder',
              message: `The description of "${action.id}" names {{${name}}}; use ${FORM_ACTION_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`,
              path: `${at}.description.${locale}`,
              action: action.id,
            });
          }
        }
      }
    } else if (options.formId !== undefined && action.form === options.formId) {
      issues.push({
        code: 'opens_itself',
        message: `"${action.id}" opens the form it is on`,
        path: `${at}.form`,
        action: action.id,
      });
    }
  });

  return issues.length === 0 ? { ok: true, actions: parsed.data } : { ok: false, issues };
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

// ---------------------------------------------------------------------------
// What a submit would do
// ---------------------------------------------------------------------------

export type PlannedAction =
  | {
      action: ExpenseClaimAction;
      /** Its condition held and the amount is more than nothing. */
      due: true;
      /** The amount, rounded to `scale` places, as decimal text. */
      amount: string;
    }
  | {
      action: ExpenseClaimAction;
      due: false;
      /** Why not: the condition, or no amount (blank, hidden, zero or less). */
      because: 'condition' | 'no_amount';
    }
  | { action: OpenFormAction; due: boolean; because?: 'condition' };

/**
 * What each action would do for these submitted answers. A condition that is
 * unknown (it reads an unanswered question) does not hold, as a hidden field's
 * would not. Amounts are rounded half away from zero to `scale` places, which
 * is the company's money scale (2 for piastres).
 */
export function planFormActions(
  form: CompiledForm,
  actions: readonly FormAction[],
  answers: Answers,
  options: { context?: EvaluationContext; scale?: number } = {},
): PlannedAction[] {
  const context = options.context ?? {};
  const evaluation = evaluateForm(form, answers, context);
  const scope = evaluationScope(form, evaluation, context);
  const holds = (when: Expression | undefined): boolean =>
    when === undefined || truth(evaluateExpression(when, scope)) === true;

  return actions.map((action): PlannedAction => {
    if (action.kind === 'open_form') {
      return holds(action.when)
        ? { action, due: true }
        : { action, due: false, because: 'condition' };
    }
    if (!holds(action.when)) {
      return { action, due: false, because: 'condition' };
    }
    const field = form.elements.get(action.amount.field)?.field;
    const value =
      field === undefined ? undefined : toRuleValue(field, evaluation.values.get(field.id));
    if (value?.type !== 'number') {
      return { action, due: false, because: 'no_amount' };
    }
    const amount: Decimal = rescale(value.value, options.scale ?? 2);
    if (compareDecimal(amount, fromInteger(0)) <= 0) {
      return { action, due: false, because: 'no_amount' };
    }
    return { action, due: true, amount: formatDecimal(amount) };
  });
}

/**
 * A claim's description in one language, placeholders filled. Falls back to
 * English, then to any language given; an unknown or empty placeholder reads
 * as nothing, and runs of spaces left behind are closed up.
 */
export function fillActionText(
  text: LocalizedText,
  locale: string,
  values: Readonly<Partial<Record<FormActionPlaceholder, string>>>,
): string {
  const chosen = text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
  return chosen
    .replace(PLACEHOLDER, (_whole, name: string) => values[name as FormActionPlaceholder] ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
