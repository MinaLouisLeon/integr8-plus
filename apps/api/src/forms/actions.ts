import { createHash } from 'node:crypto';
import { formatWorkOrderReference, type UserId } from '@integr8/core';
import type {
  FormVersion,
  Submission,
  SubmissionActionResult,
  TenantTransaction,
} from '@integr8/db';
import {
  compileDefinition,
  fillActionText,
  formActionsSchema,
  planFormActions,
  type ExpenseClaimAction,
  type FormAction,
  type OpenFormAction,
  type PlannedAction,
} from '@integr8/form-engine';
import { isFeatureEnabled } from '../http/features.js';

/**
 * Form actions (P40): what a submit does beyond saving the answers. Called in
 * the submit's own transaction by both submit paths — the screens'
 * `POST /v1/submissions/{id}/submit` and the phone's `submission.submit` — and
 * again by the office's "Make it now".
 *
 * Nothing here refuses the submission. An action that cannot be done is
 * recorded as failed, with the reason in words, and the office sees it on the
 * submission (owner's decision 6, as proposed). Each action runs in its own
 * savepoint for the same reason.
 *
 * Each claim is made once: its `client_action_id` is a name-based UUID of the
 * submission and the action, so a phone that sends the same submit twice, or a
 * retried request, finds the claim it made rather than making another.
 */

/** Form-made claims are rounded to piastres, as the company's money is. */
const CLAIM_SCALE = 2;

/** The namespace of the claim ids form actions make (a fixed, random UUID). */
const CLAIM_NAMESPACE = '5b0d7e3c-3a8e-4b6e-9f39-2f4f6a1c8d71';

/** A UUID version 5 (RFC 9562): the same name always gives the same id. */
export function nameBasedUuid(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function claimActionId(submissionId: string, formActionId: string): string {
  return nameBasedUuid(CLAIM_NAMESPACE, `${submissionId}:${formActionId}`);
}

/** A follow-up form to open now, as the submit answer and the sync pull carry it. */
export interface NextForm {
  submissionId: string;
  formId: string;
  formTitle: string;
  required: boolean;
}

export interface ActionsRun {
  results: SubmissionActionResult[];
  nextForms: NextForm[];
}

interface Failure {
  code: string;
  message: string;
}

const fail = (code: string, message: string): Failure => ({ code, message });

/** The actions a version carries, or none when they no longer read (checked at publish). */
export function actionsOf(version: FormVersion): FormAction[] {
  const parsed = formActionsSchema.safeParse(version.actions);
  return parsed.success ? parsed.data : [];
}

/**
 * Runs a submitted submission's actions that are not made yet.
 *
 * `actorId` is whoever caused the run: the submitter at submit, an office
 * person for "Make it now". Claims and follow-ups always belong to the
 * submitter, who did the work.
 */
export async function runFormActions(
  tx: TenantTransaction,
  submission: Submission,
  actorId: UserId | string,
  options: { today?: string; now?: string } = {},
): Promise<ActionsRun> {
  const version = await tx.forms.findVersion(submission.formVersionId);
  const actions = version === undefined ? [] : actionsOf(version);
  if (version === undefined || actions.length === 0 || submission.status === 'draft') {
    return { results: await tx.formActions.results(submission.id), nextForms: [] };
  }

  const done = new Map(
    (await tx.formActions.results(submission.id)).map((result) => [result.formActionId, result]),
  );
  const compiled = compileDefinition(version.definition);
  if (!compiled.ok) {
    // Every published version compiled when it was published.
    return { results: await tx.formActions.results(submission.id), nextForms: [] };
  }
  const form = compiled.form;
  const plan = planFormActions(form, actions, submission.answers, {
    context: {
      ...(options.today === undefined ? {} : { today: options.today }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
    scale: CLAIM_SCALE,
  });
  const nextForms: NextForm[] = [];

  for (const step of plan) {
    const previous = done.get(step.action.id);
    if (previous?.outcome === 'made') {
      continue;
    }
    if (!step.due) {
      await tx.formActions.recordResult(
        {
          submissionId: submission.id,
          formActionId: step.action.id,
          kind: step.action.kind,
          outcome: 'skipped',
        },
        actorId,
      );
      continue;
    }
    const attempt = await tx.formActions.attempt(
      (): Promise<{ claimId?: string; linkId?: string } | Failure> =>
        'amount' in step
          ? makeClaim(tx, submission, step, actorId)
          : openFollowUp(tx, submission, step.action, nextForms),
    );
    const outcome: { claimId?: string; linkId?: string } | Failure = attempt.ok
      ? attempt.value
      : fail('action_error', 'This could not be done just now. Try again with Make it now.');
    await tx.formActions.recordResult(
      'code' in outcome
        ? {
            submissionId: submission.id,
            formActionId: step.action.id,
            kind: step.action.kind,
            outcome: 'failed',
            reasonCode: outcome.code,
            reason: outcome.message,
          }
        : {
            submissionId: submission.id,
            formActionId: step.action.id,
            kind: step.action.kind,
            outcome: 'made',
            claimId: outcome.claimId ?? null,
            linkId: outcome.linkId ?? null,
          },
      actorId,
    );
  }

  return { results: await tx.formActions.results(submission.id), nextForms };
}

async function makeClaim(
  tx: TenantTransaction,
  submission: Submission,
  step: Extract<PlannedAction, { due: true; action: ExpenseClaimAction }>,
  actorId: UserId | string,
): Promise<{ claimId: string } | Failure> {
  const { action } = step;
  if (!(await isFeatureEnabled(submission.tenantId, 'hr'))) {
    return fail('hr_off', 'Expense claims are switched off for this company.');
  }
  const wanted = action.category.toLocaleLowerCase('en');
  const category = (await tx.hrExpenses.categories()).find(
    (candidate) => candidate.name.toLocaleLowerCase('en') === wanted,
  );
  if (category === undefined) {
    return fail(
      'category_missing',
      `There is no expense category called "${action.category}" in use. Add it, or rename one, then make the claim.`,
    );
  }
  const [settings, job, formRecord] = await Promise.all([
    tx.settings.get(),
    submission.workOrderId === null ? undefined : tx.workOrders.find(submission.workOrderId),
    tx.forms.findForm(submission.formId),
  ]);
  const spentOn = dayIn(settings.timezone, submission.submittedAt ?? new Date());
  const description = fillActionText(action.description, settings.locale, {
    ...(job === undefined
      ? {}
      : { 'job.reference': formatWorkOrderReference(job.reference), 'job.title': job.title }),
    'form.title': submission.title ?? formRecord?.title ?? '',
    'submission.date': spentOn,
  }).slice(0, 1000);

  const { claim, created } = await tx.hrExpenses.submit({
    claimantId: submission.submittedBy,
    categoryId: category.id,
    workOrderId: submission.workOrderId,
    spentOn,
    amount: step.amount,
    currency: settings.currency,
    description: description === '' ? category.name : description,
    clientActionId: claimActionId(submission.id, action.id),
    submissionId: submission.id,
    formActionId: action.id,
  });
  if (created) {
    await tx.auditLog.append({
      actorKind: 'tenant_user',
      actorId: String(actorId),
      actorLabel: String(actorId),
      action: 'expense.submitted',
      resourceType: 'expense_claim',
      resourceId: claim.id,
      metadata: {
        amount: claim.amount,
        claimantId: claim.claimantId,
        submissionId: submission.id,
        formActionId: action.id,
      },
    });
  }
  return { claimId: claim.id };
}

async function openFollowUp(
  tx: TenantTransaction,
  submission: Submission,
  action: OpenFormAction,
  nextForms: NextForm[],
): Promise<{ linkId: string } | Failure> {
  const existing = await tx.formActions.link(submission.id, action.id);
  if (existing !== undefined) {
    return { linkId: existing.id };
  }
  const target = await tx.forms.findForm(action.form);
  const version =
    target?.archivedAt !== null ? undefined : await tx.forms.findLatestPublished(target.id);
  if (target === undefined || version === undefined) {
    return fail('form_unavailable', 'The next form is archived or has nothing published to fill.');
  }
  if (submission.workOrderId !== null) {
    const job = await tx.workOrders.find(submission.workOrderId);
    if (job !== undefined && ['complete', 'reviewed', 'cancelled'].includes(job.state)) {
      return fail('work_order_closed', 'The job is closed, so the next form was not opened.');
    }
    // A job's submissions are for its own forms, so the next form joins the
    // job's list: phones show it there, and a required one holds the job open
    // like a required form of its type. One already on the job is never made
    // optional by this.
    const listed = (await tx.workOrders.listForms(submission.workOrderId)).find(
      (entry) => entry.formId === target.id,
    );
    if (listed === undefined || (action.required && !listed.required)) {
      await tx.workOrders.addForm(
        submission.workOrderId,
        target.id,
        action.required,
        submission.submittedBy,
      );
    }
  }
  const draft = await tx.submissions.startDraft({
    formVersionId: version.id,
    submittedBy: submission.submittedBy,
    ...(submission.workOrderId === null ? {} : { workOrderId: submission.workOrderId }),
    ...(submission.assetId === null ? {} : { assetId: submission.assetId }),
  });
  const link = await tx.formActions.createLink({
    fromSubmissionId: submission.id,
    toSubmissionId: draft.id,
    formActionId: action.id,
    required: action.required,
  });
  nextForms.push({
    submissionId: draft.id,
    formId: target.id,
    formTitle: target.title,
    required: action.required,
  });
  return { linkId: link.id };
}

/** The follow-ups of a submission still to fill, for its submitter. */
export async function openNextForms(
  tx: TenantTransaction,
  submission: Submission,
): Promise<NextForm[]> {
  const { to } = await tx.formActions.linksOf(submission.id);
  const found: NextForm[] = [];
  for (const link of to) {
    const draft = await tx.submissions.findById(link.toSubmissionId);
    if (draft?.status !== 'draft') {
      continue;
    }
    const target = await tx.forms.findForm(draft.formId);
    found.push({
      submissionId: draft.id,
      formId: draft.formId,
      formTitle: target?.title ?? '',
      required: link.required,
    });
  }
  return found;
}

function dayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
