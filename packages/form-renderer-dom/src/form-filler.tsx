import {
  type Answers,
  type CompiledForm,
  createFormState,
  type FieldError,
  type FormEvent,
  type FormState,
  ownAnswer,
  storedEntries,
  toSubmission,
  touchKey,
  transition,
  viewForm,
} from '@integr8/form-engine';
import {
  dependentChoices,
  firstPerField,
  isRequiredNow,
  pageIndexOfField,
} from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { useId, useMemo, useRef, useState } from 'react';
import { AnswerView } from './answer-view.js';
import { EntryList, entryName, entryPrefix, sectionName, sectionProblemsId } from './entries.js';
import { controlId, FieldBlock } from './field.js';
import type { MediaAdapter } from './media.js';
import { say } from './text.js';
import { buttonClass, inputClass } from './widgets/types.js';

/**
 * A form, filled in: the React DOM renderer.
 *
 * Driven entirely by @integr8/form-engine — which questions show, what is
 * worked out, what is wrong, how far along the person is — so nothing here
 * knows anything about any particular form. The same state machine runs on the
 * phone in P13 and its rules run again on the server when this submits.
 *
 * The flow for a long form:
 *
 *   pages, one at a time, with every section listed beside them
 *     → "Review answers": if anything required is missing or wrong, a list of
 *       every problem, each a link to its question
 *     → a review screen of exactly what will be sent
 *     → submit; if the server refuses, its reasons, each a link back
 */

export type SubmitOutcome =
  | { ok: true }
  | {
      ok: false;
      /** The server's field-level details, keyed by answer id where there is one. */
      problems: { field: string | undefined; entry?: string | undefined; message: string }[];
    };

export interface FormFillerProps {
  form: CompiledForm;
  initialAnswers?: Answers;
  locale: string;
  media?: MediaAdapter;
  /** The day the form is being filled, `YYYY-MM-DD`, for rules about today. */
  today?: string;
  /** After every change: everything typed, for autosave. */
  onAnswersChange?: (answers: Record<string, unknown>) => void;
  /** Sends what the engine says to submit: visible answers, no calculated values. */
  onSubmit: (
    answers: Record<string, unknown>,
    extra: { reason?: string },
  ) => Promise<SubmitOutcome>;
  /** Correcting a submitted form: a reason is asked for before it goes. */
  correction?: boolean;
  /** Makes the id of a new entry of a repeatable section. A UUID unless a test says otherwise. */
  newEntryId?: () => string;
}

const randomEntryId = () => crypto.randomUUID();

export function FormFiller({
  form,
  initialAnswers,
  locale,
  media,
  today,
  onAnswersChange,
  onSubmit,
  correction = false,
  newEntryId = randomEntryId,
}: FormFillerProps) {
  const { t } = useTranslation();
  const prefix = useId().replaceAll(':', '');
  const context = useMemo(() => (today === undefined ? {} : { today }), [today]);
  // A repeatable section that needs entries opens with that many.
  const [state, setState] = useState<FormState>(() =>
    createFormState(form, initialAnswers, { newEntryId }),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refused, setRefused] = useState<SubmitOutcome & { ok: false }>();
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);

  const view = useMemo(() => viewForm(form, state, context), [form, state, context]);
  const pages = form.definition.pages.filter((page) => view.visible.get(page.id) === true);
  const current = pages[Math.min(pageIndex, Math.max(pages.length - 1, 0))];
  const currentIndex = current === undefined ? 0 : pages.indexOf(current);

  // Events build on the latest state, not the one this render saw: a widget
  // often answers and then marks itself touched in the same tick, and the second
  // event must not undo the first.
  const latest = useRef(state);
  const dispatch = (event: FormEvent) => {
    const result = transition(form, latest.current, event, context);
    latest.current = result.state;
    setState(result.state);
    if (
      result.accepted &&
      event.type !== 'touch' &&
      event.type !== 'submit' &&
      event.type !== 'reopen'
    ) {
      onAnswersChange?.({ ...result.state.answers });
    }
    return result;
  };

  const pageOfField = (fieldId: string) => {
    const index = pageIndexOfField(pages, fieldId);
    return index === -1 ? currentIndex : index;
  };

  /**
   * The control a problem is about: a question, a question in one entry, or a
   * repeatable section's own problems — or, for a question in a repeatable
   * section named without its entry, the section.
   */
  const targetOf = (fieldId: string, entry: string | undefined) => {
    const section = form.elements.get(fieldId)?.entries;
    if (form.elements.get(fieldId)?.repeat !== undefined) {
      return [sectionProblemsId(prefix, fieldId), `${prefix}-section-${fieldId}-title`];
    }
    if (section === undefined) {
      return [controlId(prefix, fieldId)];
    }
    return entry === undefined
      ? [`${prefix}-section-${section}-title`, `${prefix}-section-${section}-add`]
      : [controlId(entryPrefix(prefix, entry), fieldId)];
  };

  const goToField = (fieldId: string, entry?: string) => {
    if (reviewing) {
      dispatch({ type: 'reopen' });
      setReviewing(false);
    }
    setPageIndex(pageOfField(fieldId));
    // After the page it is on has rendered.
    setTimeout(() => {
      const target = targetOf(fieldId, entry)
        .map((id) => document.getElementById(id))
        .find((element) => element !== null);
      target?.focus();
      target?.scrollIntoView?.({ block: 'center' });
    }, 0);
  };

  const review = () => {
    const result = dispatch({ type: 'submit' });
    if (result.accepted) {
      setRefused(undefined);
      setReviewing(true);
      top.current?.focus();
      return;
    }
    const first = viewForm(form, result.state, context).shownErrors[0];
    if (first !== undefined) {
      setPageIndex(pageOfField(first.field));
    }
    // The summary appears after this render; focusing it announces every problem at once.
    setTimeout(() => summary.current?.focus(), 0);
  };

  const submit = async () => {
    if (correction && reason.trim() === '') {
      setReasonMissing(true);
      return;
    }
    setSubmitting(true);
    setRefused(undefined);
    try {
      const outcome = await onSubmit(
        toSubmission(form, state, context),
        correction ? { reason: reason.trim() } : {},
      );
      if (!outcome.ok) {
        setRefused(outcome);
        setTimeout(() => summary.current?.focus(), 0);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const labelOf = (fieldId: string | undefined) => {
    if (fieldId === undefined) {
      return '';
    }
    const element = form.elements.get(fieldId);
    if (element?.repeat !== undefined) {
      const section = form.definition.pages
        .flatMap((page) => page.sections)
        .find((candidate) => candidate.id === fieldId);
      return section === undefined ? fieldId : sectionName(section, locale);
    }
    const field = element?.field;
    return field === undefined ? '' : say(field.label, locale) || field.id;
  };

  /** "Go to “Make” in Appliance 2 · Worcester": the problem list names the entry. */
  const problemLink = (error: FieldError) => {
    const sectionId = form.elements.get(error.field)?.entries;
    const section =
      sectionId === undefined
        ? undefined
        : form.definition.pages
            .flatMap((page) => page.sections)
            .find((candidate) => candidate.id === sectionId);
    const entries = sectionId === undefined ? [] : (view.entries.get(sectionId) ?? []);
    const index = entries.findIndex((entry) => entry.id === error.entry);
    if (section === undefined || index === -1) {
      return t('fill.summary.goTo', { question: labelOf(error.field) });
    }
    return t('fill.summary.goToInEntry', {
      question: labelOf(error.field),
      entry: entryName(section, entries[index]!, index, locale, t),
    });
  };

  // One entry per question, in reading order: its first problem.
  const problems = state.submitAttempted && !reviewing ? firstPerField(view.shownErrors) : [];

  return (
    <div className="grid gap-6 text-start lg:grid-cols-[16rem_minmax(0,1fr)]">
      <nav
        aria-label={t('fill.nav.label')}
        className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start"
      >
        <Progress answered={view.progress.requiredAnswered} total={view.progress.requiredTotal} />
        <ol className="flex flex-col gap-1">
          {pages.map((page, index) => {
            const count = firstPerField(view.shownErrors).filter(
              (error) => pageOfField(error.field) === index,
            ).length;
            return (
              <li key={page.id}>
                <button
                  type="button"
                  aria-current={!reviewing && index === currentIndex ? 'step' : undefined}
                  onClick={() => {
                    if (reviewing) {
                      dispatch({ type: 'reopen' });
                      setReviewing(false);
                    }
                    setPageIndex(index);
                    top.current?.focus();
                  }}
                  className={[
                    'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-start text-sm',
                    !reviewing && index === currentIndex
                      ? 'bg-accent-subtle font-medium text-content'
                      : 'text-content hover:bg-surface-muted',
                  ].join(' ')}
                >
                  <span>
                    {say(page.title, locale) || t('fill.nav.page', { number: index + 1 })}
                  </span>
                  {count === 0 ? null : (
                    <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-xs text-danger">
                      {t('fill.nav.problems', { count })}
                    </span>
                  )}
                </button>
                {!reviewing && index === currentIndex ? (
                  <ul className="ms-3 flex flex-col border-s border-border-subtle">
                    {page.sections
                      .filter(
                        (section) =>
                          view.visible.get(section.id) === true && section.title !== undefined,
                      )
                      .map((section) => (
                        <li key={section.id}>
                          <a
                            href={`#${prefix}-section-${section.id}`}
                            className="block px-3 py-1 text-xs text-content-muted hover:text-content"
                          >
                            {say(section.title, locale)}
                          </a>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="flex min-w-0 flex-col gap-6">
        <div ref={top} tabIndex={-1} className="outline-none">
          <h2 className="text-xl font-semibold text-content">
            {say(form.definition.title, locale)}
          </h2>
        </div>

        {problems.length > 0 ? (
          <div
            ref={summary}
            tabIndex={-1}
            role="alert"
            aria-labelledby={`${prefix}-problems`}
            className="flex flex-col gap-2 rounded-lg border border-danger bg-danger-subtle p-4"
          >
            <h3 id={`${prefix}-problems`} className="text-sm font-semibold text-content">
              {t('fill.summary.title', { count: problems.length })}
            </h3>
            <ul className="flex flex-col gap-1">
              {problems.map((error) => (
                <li key={touchKey(error.field, error.entry)}>
                  <button
                    type="button"
                    className="text-start text-sm text-danger underline"
                    onClick={() => goToField(error.field, error.entry)}
                  >
                    {problemLink(error)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {reviewing ? (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <h3 className="text-lg font-semibold text-content">{t('fill.review.title')}</h3>
              <p className="text-sm text-content-muted">{t('fill.review.intro')}</p>
            </div>

            {refused === undefined ? null : (
              <div
                ref={summary}
                tabIndex={-1}
                role="alert"
                className="flex flex-col gap-2 rounded-lg border border-danger bg-danger-subtle p-4"
              >
                <h4 className="text-sm font-semibold text-content">{t('fill.review.refused')}</h4>
                <ul className="flex flex-col gap-1">
                  {refused.problems.map((problem) => (
                    <li
                      key={`${problem.field ?? ''}-${problem.entry ?? ''}-${problem.message}`}
                      className="text-sm text-content"
                    >
                      {problem.field === undefined ||
                      (form.elements.get(problem.field)?.field === undefined &&
                        form.elements.get(problem.field)?.repeat === undefined) ? (
                        problem.message
                      ) : (
                        <button
                          type="button"
                          className="text-start text-danger underline"
                          onClick={() => goToField(problem.field!, problem.entry)}
                        >
                          {`${labelOf(problem.field)}: ${problem.message}`}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <AnswerView
              form={form}
              answers={state.answers}
              locale={locale}
              media={media}
              today={today}
              onChangePage={(index) => {
                dispatch({ type: 'reopen' });
                setReviewing(false);
                const visibleIndex = pages.indexOf(form.definition.pages[index]!);
                setPageIndex(visibleIndex === -1 ? 0 : visibleIndex);
              }}
            />

            {correction ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${prefix}-reason`} className="text-sm font-medium text-content">
                  {t('fill.review.reason')}
                  <span aria-hidden="true" className="text-danger">
                    {' *'}
                  </span>
                </label>
                <p id={`${prefix}-reason-hint`} className="text-xs text-content-muted">
                  {t('fill.review.reasonHint')}
                </p>
                <textarea
                  id={`${prefix}-reason`}
                  rows={2}
                  maxLength={2000}
                  value={reason}
                  aria-required
                  aria-invalid={reasonMissing}
                  aria-describedby={`${prefix}-reason-hint${reasonMissing ? ` ${prefix}-reason-error` : ''}`}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setReasonMissing(false);
                  }}
                  className={inputClass}
                />
                {reasonMissing ? (
                  <p id={`${prefix}-reason-error`} role="alert" className="text-xs text-danger">
                    {t('fill.review.reasonRequired')}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap justify-between gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  dispatch({ type: 'reopen' });
                  setReviewing(false);
                }}
              >
                {t('fill.actions.edit')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={submitting}
                aria-busy={submitting}
                onClick={() => void submit()}
              >
                {correction ? t('fill.actions.submitCorrection') : t('fill.actions.submit')}
              </button>
            </div>
          </div>
        ) : current === undefined ? null : (
          <div className="flex flex-col gap-6">
            {pages.length > 1 || current.title !== undefined ? (
              <h3 className="text-lg font-semibold text-content">
                {say(current.title, locale) || t('fill.nav.page', { number: currentIndex + 1 })}
              </h3>
            ) : null}

            {current.sections
              .filter((section) => view.visible.get(section.id) === true)
              .map((section) => (
                <section
                  key={section.id}
                  id={`${prefix}-section-${section.id}`}
                  {...(section.title === undefined
                    ? {}
                    : { 'aria-labelledby': `${prefix}-section-${section.id}-title` })}
                  className="flex flex-col gap-5 rounded-lg border border-border-subtle bg-surface p-4 sm:p-6"
                >
                  {section.title === undefined ? null : (
                    <h4
                      id={`${prefix}-section-${section.id}-title`}
                      tabIndex={section.repeat === undefined ? undefined : -1}
                      className="text-base font-semibold text-content outline-none"
                    >
                      {say(section.title, locale)}
                    </h4>
                  )}
                  {section.repeat === undefined ? null : (
                    <EntryList
                      section={section}
                      view={view}
                      locale={locale}
                      prefix={prefix}
                      newEntryId={newEntryId}
                      onEvent={(event) => void dispatch(event)}
                      renderField={(field, { entry, prefix: own, errors }) => (
                        <FieldBlock
                          key={field.id}
                          field={field}
                          value={
                            entry.values.get(field.id) ??
                            ownAnswer(
                              storedEntries(state.answers, section.id).find(
                                (stored) => stored.id === entry.id,
                              )?.values ?? {},
                              field.id,
                            )
                          }
                          errors={errors}
                          prefix={own}
                          locale={locale}
                          media={media}
                          disabled={false}
                          required={isRequiredNow(view, field, entry.id)}
                          choices={dependentChoices(form, view, field, locale, entry.id)}
                          onAnswer={(value) =>
                            dispatch({ type: 'answer', field: field.id, value, entry: entry.id })
                          }
                          onClear={() =>
                            dispatch({ type: 'clear', field: field.id, entry: entry.id })
                          }
                          onBlur={() =>
                            dispatch({ type: 'touch', field: field.id, entry: entry.id })
                          }
                        />
                      )}
                    />
                  )}
                  {section.fields
                    .filter(
                      (field) =>
                        section.repeat === undefined && view.visible.get(field.id) === true,
                    )
                    .map((field) => (
                      <FieldBlock
                        key={field.id}
                        field={field}
                        value={view.values.get(field.id) ?? state.answers[field.id]}
                        errors={view.shownErrors.filter(
                          (error) => error.field === field.id && error.entry === undefined,
                        )}
                        prefix={prefix}
                        locale={locale}
                        media={media}
                        disabled={false}
                        required={isRequiredNow(view, field)}
                        choices={dependentChoices(form, view, field, locale)}
                        onAnswer={(value) => dispatch({ type: 'answer', field: field.id, value })}
                        onClear={() => dispatch({ type: 'clear', field: field.id })}
                        onBlur={() => dispatch({ type: 'touch', field: field.id })}
                      />
                    ))}
                </section>
              ))}

            <div className="flex flex-wrap justify-between gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={currentIndex === 0}
                onClick={() => {
                  setPageIndex(currentIndex - 1);
                  top.current?.focus();
                }}
              >
                {t('fill.actions.back')}
              </button>
              {currentIndex < pages.length - 1 ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => {
                    setPageIndex(currentIndex + 1);
                    top.current?.focus();
                  }}
                >
                  {t('fill.actions.next')}
                </button>
              ) : (
                <button type="button" className={buttonClass.primary} onClick={review}>
                  {t('fill.actions.review')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ answered, total }: { answered: number; total: number }) {
  const { t } = useTranslation();
  const label =
    total === 0 || answered === total
      ? t('fill.nav.complete')
      : t('fill.nav.progress', { answered, total });
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={Math.max(total, 1)}
        aria-valuenow={total === 0 ? 1 : answered}
        aria-label={label}
        className="h-2 overflow-hidden rounded-full bg-surface-muted"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${String(total === 0 ? 100 : Math.round((answered / total) * 100))}%` }}
        />
      </div>
      <p className="text-xs text-content-muted">{label}</p>
    </div>
  );
}
