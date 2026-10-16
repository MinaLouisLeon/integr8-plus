import { type CompiledForm, evaluateForm, type FormEvaluation } from '@integr8/form-engine';
import { formatDate } from '@integr8/i18n/core';
import type { TemplateDesign } from './design.js';
import { formatAnswer, isBlank, say } from './format.js';
import { type DocumentLocale, wordsFor } from './words.js';

/**
 * A document's fields (docs/documents/ADR-0001 D6): typed by the person making
 * the PDF, or taken from the submission when it is made. The values are what
 * the register searches, what the website lookup compares, and what the page
 * may print.
 */

/** What the document knows about where it came from. */
export interface SubmissionFacts {
  companyName: string;
  formTitle: string;
  /** ISO instant, or null for a draft. */
  submittedAt: string | null;
  submittedBy: string | null;
  workOrderReference: string | null;
  assetReference: string | null;
  /** ISO instant the document is made. */
  documentDate: string;
  /** The company's time zone, for dates. */
  timeZone: string;
}

export interface ResolvedField {
  key: string;
  label: Readonly<Record<string, string>>;
  value: string;
  lookupRole: 'key' | 'confirm' | null;
}

export interface FieldProblem {
  key: string;
  code: 'required' | 'too_long' | 'unknown';
}

export type FieldResolution =
  { ok: true; fields: ResolvedField[] } | { ok: false; problems: FieldProblem[] };

/** A fact about the submission, as a document field shows it. */
export function factValue(
  value:
    | 'form_title'
    | 'submitted_date'
    | 'submitted_by'
    | 'work_order_reference'
    | 'asset_reference'
    | 'document_date',
  facts: SubmissionFacts,
  locale: DocumentLocale,
): string {
  switch (value) {
    case 'form_title':
      return facts.formTitle;
    case 'submitted_date':
      return facts.submittedAt === null
        ? ''
        : formatDate(facts.submittedAt, { locale, timeZone: facts.timeZone });
    case 'submitted_by':
      return facts.submittedBy ?? '';
    case 'work_order_reference':
      return facts.workOrderReference ?? '';
    case 'asset_reference':
      return facts.assetReference ?? '';
    case 'document_date':
      return formatDate(facts.documentDate, { locale, timeZone: facts.timeZone });
  }
}

export function resolveDocumentFields(input: {
  design: TemplateDesign;
  form: CompiledForm;
  answers: Readonly<Record<string, unknown>>;
  /** What the person typed, by field key. Keys the template does not have are refused. */
  typed: Readonly<Record<string, string>>;
  facts: SubmissionFacts;
  locale: DocumentLocale;
  today?: string;
  /** Already worked out by the caller, to avoid evaluating the form twice. */
  evaluation?: FormEvaluation;
}): FieldResolution {
  const { design, form, facts, locale } = input;
  const problems: FieldProblem[] = [];
  const known = new Set(design.fields.map((field) => field.key));
  for (const key of Object.keys(input.typed)) {
    if (!known.has(key)) {
      problems.push({ key, code: 'unknown' });
    }
  }
  const evaluation =
    input.evaluation ??
    evaluateForm(form, input.answers, input.today === undefined ? {} : { today: input.today });
  const words = wordsFor(locale);
  const fields: ResolvedField[] = [];
  for (const field of design.fields) {
    let value = '';
    switch (field.source.kind) {
      case 'typed': {
        const typed = (input.typed[field.key] ?? '').trim();
        if (typed === '' && field.source.required) {
          problems.push({ key: field.key, code: 'required' });
        } else if (typed.length > field.source.maxLength) {
          problems.push({ key: field.key, code: 'too_long' });
        }
        value = typed;
        break;
      }
      case 'answer': {
        const source = form.elements.get(field.source.fieldId)?.field;
        const answer = evaluation.values.get(field.source.fieldId);
        value =
          source === undefined || isBlank(answer)
            ? ''
            : formatAnswer(source, answer, { locale, words, timeZone: facts.timeZone });
        break;
      }
      case 'submission':
        value = factValue(field.source.value, facts, locale);
        break;
    }
    if (input.typed[field.key] !== undefined && field.source.kind !== 'typed') {
      problems.push({ key: field.key, code: 'unknown' });
    }
    if (value === '') {
      continue;
    }
    fields.push({
      key: field.key,
      label: field.label,
      value: value.slice(0, 500),
      lookupRole: field.lookup === 'none' ? null : field.lookup,
    });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, fields };
}

/** A document field's label in the document's language. */
export function fieldLabel(field: Pick<ResolvedField, 'label'>, locale: DocumentLocale): string {
  return say(field.label, locale);
}
