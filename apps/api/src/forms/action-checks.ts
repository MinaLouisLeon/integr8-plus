import type { TenantTransaction } from '@integr8/db';
import { checkFormActions, type CompiledForm, type FormActionIssue } from '@integr8/form-engine';
import type { ErrorDetail } from '../http/errors.js';
import { isFeatureEnabled } from '../http/features.js';

/**
 * What stands between a draft's actions and publishing (P40): the engine's own
 * checks against the form, then the company's — each claim's category is in
 * use, each next form exists and has something published, and the HR module is
 * on when any action makes claims (expenses live there).
 */

export const COMPANY_ACTION_ISSUE_CODES = [
  'unknown_category',
  'form_unavailable',
  'needs_module',
] as const;

export interface ActionIssue {
  code: FormActionIssue['code'] | (typeof COMPANY_ACTION_ISSUE_CODES)[number];
  message: string;
  path: string;
  action?: string;
}

export async function actionIssues(
  tx: TenantTransaction,
  tenantId: string,
  formId: string,
  actions: unknown,
  form: CompiledForm,
): Promise<ActionIssue[]> {
  const checked = checkFormActions(actions, form, { formId });
  if (!checked.ok) {
    return checked.issues;
  }
  const issues: ActionIssue[] = [];
  const claims = checked.actions.filter((action) => action.kind === 'expense_claim');
  if (claims.length > 0 && !(await isFeatureEnabled(tenantId, 'hr'))) {
    issues.push({
      code: 'needs_module',
      message:
        'This form makes expense claims, which need the HR module. Switch it on for the company, or remove the claim actions.',
      path: '',
    });
  }
  const categories = new Set(
    (await tx.hrExpenses.categories()).map((category) => category.name.toLocaleLowerCase('en')),
  );
  for (const [index, action] of checked.actions.entries()) {
    const at = `[${String(index)}]`;
    if (action.kind === 'expense_claim') {
      if (!categories.has(action.category.toLocaleLowerCase('en'))) {
        issues.push({
          code: 'unknown_category',
          message: `The company has no expense category called "${action.category}" in use.`,
          path: `${at}.category`,
          action: action.id,
        });
      }
      continue;
    }
    const target = await tx.forms.findForm(action.form);
    const published =
      target?.archivedAt !== null ? undefined : await tx.forms.findLatestPublished(target.id);
    if (published === undefined) {
      issues.push({
        code: 'form_unavailable',
        message: `"${action.id}" opens a form that is archived, missing or not published yet.`,
        path: `${at}.form`,
        action: action.id,
      });
    }
  }
  return issues;
}

/** As the 422's details, each named by where it is in the actions. */
export function actionIssueDetails(issues: readonly ActionIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    field: `actions${issue.path}`,
    code: issue.code,
    message: issue.message,
  }));
}
