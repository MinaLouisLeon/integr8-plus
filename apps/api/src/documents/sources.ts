import { formatAssetReference, formatWorkOrderReference } from '@integr8/core';
import type { Submission, TenantTransaction } from '@integr8/db';
import type { DocumentLocale, SubmissionFacts, TemplateDesign } from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import { internal } from '../http/errors.js';
import { compiledVersion } from '../routes/v1/submissions.js';

/**
 * What a document is made from, besides its template (ADR-0001 D6): the form
 * as the submission answered it, the answers, and the facts about the
 * submission that fields and text may show. The same reading serves the
 * export request, which resolves the document's fields, and the render job,
 * which prints them, so the two cannot disagree.
 */

export interface DocumentSources {
  form: CompiledForm;
  answers: Readonly<Record<string, unknown>>;
  facts: SubmissionFacts;
  locale: DocumentLocale;
  /** The day the submission's calculations are evaluated on, `YYYY-MM-DD`. */
  today: string;
}

export async function documentSources(
  tx: TenantTransaction,
  input: {
    submission: Submission;
    design: TemplateDesign;
    companyName: string;
    /** When the document is made. */
    documentDate: Date;
  },
): Promise<DocumentSources> {
  const { submission } = input;
  const [settings, version, form, person, jobs, asset] = await Promise.all([
    tx.settings.get(),
    tx.forms.findVersion(submission.formVersionId),
    tx.forms.findForm(submission.formId),
    tx.tenantUsers.findByUserId(submission.submittedBy),
    submission.workOrderId === null ? [] : tx.workOrders.findMany([submission.workOrderId]),
    submission.assetId === null ? undefined : tx.assets.find(submission.assetId),
  ]);
  if (version === undefined) {
    throw internal();
  }
  const job = jobs[0];
  return {
    form: compiledVersion(version),
    answers: submission.answers,
    facts: {
      companyName: input.companyName,
      formTitle: form?.title ?? '',
      submittedAt: submission.submittedAt?.toISOString() ?? null,
      submittedBy: person?.displayName ?? null,
      workOrderReference: job === undefined ? null : formatWorkOrderReference(job.reference),
      assetReference: asset === undefined ? null : formatAssetReference(asset.reference),
      documentDate: input.documentDate.toISOString(),
      timeZone: settings.timezone,
    },
    locale: input.design.page.language ?? (settings.locale.startsWith('ar') ? 'ar' : 'en'),
    today: dayIn(submission.submittedAt ?? input.documentDate, settings.timezone),
  };
}

/** A moment's calendar day in a time zone, as `YYYY-MM-DD`. */
export function dayIn(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(moment);
}
