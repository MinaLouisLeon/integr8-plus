import type { DocumentTemplate, TenantTransaction } from '@integr8/db';
import { checkDesignAgainstForm, type DesignIssue, parseDesign } from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import { compiledVersion } from '../routes/v1/submissions.js';

/**
 * PDF templates against their form's versions (1.3.0 decision 13).
 *
 * A template names the form's questions by id. When a published version drops
 * or changes a question a template uses, the template is not refused or
 * broken: the publish check lists it first, it is marked "needs attention"
 * afterwards with the blocks to fix, and documents keep printing (the
 * renderer leaves out what it cannot show). These are the helpers that work
 * out which templates and which blocks.
 */

/** One thing in a template that no longer matches the form. */
export interface TemplateProblem {
  /** `blocks.<id>`, `fields.<key>`, as `checkDesignAgainstForm` names it. */
  path: string;
  code: DesignIssue['code'];
  message: string;
  /** The block it is in, when it is in one. */
  blockId: string | null;
  /** The document field it is in, when it is in one. */
  fieldKey: string | null;
}

function problemOf(issue: DesignIssue): TemplateProblem {
  const [scope, id] = issue.path.split('.');
  return {
    path: issue.path,
    code: issue.code,
    message: issue.message,
    blockId: scope === 'blocks' && id !== undefined ? id : null,
    fieldKey: scope === 'fields' && id !== undefined ? id : null,
  };
}

/** Problems in a stored design against a form version; none when there is no version yet. */
export function templateProblems(
  design: unknown,
  form: CompiledForm | undefined,
): TemplateProblem[] {
  const parsed = parseDesign(design);
  if (!parsed.ok) {
    return parsed.issues.map(problemOf);
  }
  return form === undefined ? [] : checkDesignAgainstForm(parsed.design, form).map(problemOf);
}

/** A problem's identity, to tell an old one from a new one. */
export function problemKey(problem: Pick<TemplateProblem, 'path' | 'code' | 'message'>): string {
  return `${problem.path}\u0000${problem.code}\u0000${problem.message}`;
}

/** Each form's latest published version, compiled, for the templates given. */
export async function latestForms(
  tx: TenantTransaction,
  formIds: readonly string[],
): Promise<Map<string, CompiledForm | undefined>> {
  const forms = new Map<string, CompiledForm | undefined>();
  for (const formId of new Set(formIds)) {
    const version = await tx.forms.findLatestPublished(formId);
    forms.set(formId, version === undefined ? undefined : compiledVersion(version));
  }
  return forms;
}

export interface AffectedTemplate {
  templateId: string;
  name: string;
  problems: TemplateProblem[];
}

/**
 * The templates a new version would leave needing attention: the problems it
 * would have against `next` that it does not already have against `live`.
 * Archived templates are left out; nobody makes documents from them.
 */
export function templatesAffected(
  templates: readonly DocumentTemplate[],
  live: CompiledForm | undefined,
  next: CompiledForm,
): AffectedTemplate[] {
  return templates.flatMap((template) => {
    if (template.archivedAt !== null) {
      return [];
    }
    const already = new Set(templateProblems(template.design, live).map(problemKey));
    const problems = templateProblems(template.design, next).filter(
      (problem) => !already.has(problemKey(problem)),
    );
    return problems.length === 0
      ? []
      : [{ templateId: template.id, name: template.name, problems }];
  });
}
