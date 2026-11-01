import {
  type CompiledForm,
  type EntryEvaluation,
  type EvaluationContext,
  type Field,
  type FieldError,
  type FormEvent,
  type FormState,
  type FormView,
  type Information,
  isAnswered,
  isCalculated,
  isInformation,
  type LocalizedText,
  ownAnswer,
  type Section,
  storedEntries,
  touchKey,
  transition,
  viewForm,
} from '@integr8/form-engine';
import {
  calculatedText,
  canAddEntry,
  type DependentChoices,
  dependentChoices,
  entriesOf,
  entryErrors,
  entryTitle,
  errorMessage,
  firstPerField,
  informationText,
  isRequiredNow,
  needsNewerApp,
  offeredOptions,
  pageIndexOfField,
  progressFraction,
  say,
  sectionErrors,
  toggleOffered,
  visiblePages,
} from '@integr8/form-input';
import { isRtl, useTranslation } from '@integr8/i18n';
import { brandAccentVariables, colourVariables, fontFamily, type Theme } from '@integr8/tokens';
import { type CSSProperties, type ReactNode, useState } from 'react';

/**
 * The builder's phone: the form as the company's phone app draws it.
 *
 * Laid out from the phone's own screen (`apps/mobile/src/forms`): its header
 * with the progress bar, one page at a time, sections as cards, questions with
 * a large label and a red edge when something is wrong, choices as
 * whole-width rows, yes/no and ratings as big segments, every control at least
 * 56 points tall, one entry of a repeating section at a time — in the phone's
 * system font, at the phone's type sizes, and in the company's colours and
 * theme as the phone computes them (`@integr8/tokens`: the same palette and the
 * same accent derivation).
 *
 * It is a drawing in the desktop's DOM, not the phone's code: a native date
 * picker, the camera and a signature pad are stood in for. What it shows —
 * which questions, their words, required marks and errors at every step — is
 * held to the phone app's own screens by the behaviour check
 * (`phone-preview.behaviour.test.tsx` here, `behaviour.test.tsx` in the
 * mobile app; docs/form-engine/builder.md).
 *
 * Text that is not a question (form format 2) is drawn as the phone draws it
 * (`apps/mobile/src/forms/information.tsx`): descriptions under page and
 * section titles, Information blocks in their plain, tip or warning style; a
 * calculated date is written as the phone writes one. A form too new for the
 * app — or, at the builder's choice, this form opened by an app from before
 * 1.3.0 — shows the phone's "Update the app" screen instead of the form.
 *
 * Controlled like the desktop view beside it: both share one set of answers.
 */

export interface PhoneBrand {
  /** The company's brand colour, as on the branding screen; `null` keeps the product's blue. */
  colour: string | null;
  theme: Theme;
}

export interface PhonePreviewProps {
  form: CompiledForm;
  state: FormState;
  view: FormView;
  onEvent: (event: FormEvent) => void;
  locale: string;
  /** What rules about today read; the same as the view was made with. */
  context: EvaluationContext;
  brand: PhoneBrand;
  /** Makes the id of an added entry. A UUID unless a test says otherwise. */
  newEntryId?: (() => string) | undefined;
  /**
   * Shows the form as an app too old for it would: the phone's "Update the
   * app" screen. For a form that uses what form format 2 added, which an app
   * from before 1.3.0 does not open.
   */
  olderApp?: boolean | undefined;
}

/** The phone's colours and font, as custom properties for everything inside the frame. */
export function phoneStyle(brand: PhoneBrand): CSSProperties {
  return {
    ...colourVariables(brand.theme),
    ...(brand.colour === null ? {} : brandAccentVariables(brand.colour, brand.theme)),
    '--font-sans': fontFamily.sans,
    fontFamily: fontFamily.sans,
  } as CSSProperties;
}

export function PhonePreview(props: PhonePreviewProps) {
  const { form, state, view, onEvent, locale, brand, context } = props;
  const { t } = useTranslation();
  const pages = visiblePages(form, view);
  const [pageIndex, setPageIndex] = useState(0);
  const [open, setOpen] = useState<{ section: string; entry: string } | undefined>(undefined);
  const current = Math.min(pageIndex, Math.max(pages.length - 1, 0));
  const page = pages[current];
  const reviewing = view.status === 'submitted';
  const problems = state.submitAttempted && !reviewing ? firstPerField(view.shownErrors) : [];
  // An entry that has gone — removed, or its section hidden — is not open.
  const openEntry =
    open !== undefined && (view.entries.get(open.section) ?? []).some((e) => e.id === open.entry)
      ? open
      : undefined;

  /** Review: when something is wrong, the page with the first problem opens, as on the phone. */
  const review = () => {
    const result = transition(form, state, { type: 'submit' }, context);
    onEvent({ type: 'submit' });
    const first = viewForm(form, result.state, context).shownErrors[0];
    if (!result.accepted && first !== undefined) {
      const index = pageIndexOfField(pages, first.field);
      setPageIndex(index === -1 ? current : index);
      setOpen(undefined);
    }
  };

  const goTo = (index: number) => {
    if (reviewing) {
      onEvent({ type: 'reopen' });
    }
    setPageIndex(index);
    setOpen(undefined);
  };

  if (props.olderApp === true || needsNewerApp(form.definition)) {
    return (
      <Frame locale={locale} brand={brand}>
        <div className="flex flex-col gap-4 px-4 pb-16 pt-4">
          <div>
            <ActionButton label={t('mobile.back')} decorative />
          </div>
          <div
            data-part="update-app"
            className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-6"
          >
            <p className="text-xl font-semibold">{t('fill.updateApp.title')}</p>
            <p className="text-sm text-content-muted">{t('fill.updateApp.body')}</p>
          </div>
        </div>
      </Frame>
    );
  }

  const progressLabel =
    view.progress.requiredTotal === 0 ||
    view.progress.requiredAnswered === view.progress.requiredTotal
      ? t('fill.nav.complete')
      : t('fill.nav.progress', {
          answered: view.progress.requiredAnswered,
          total: view.progress.requiredTotal,
        });

  return (
    <Frame locale={locale} brand={brand}>
      <header className="flex flex-col gap-2 border-b border-border-subtle bg-surface px-4 pb-3 pt-2">
        <div className="flex items-center justify-between gap-3">
          <ActionButton tone="quiet" label={t('mobile.back')} decorative />
          <p className="min-w-0 flex-1 truncate text-xl font-bold">
            {say(form.definition.title, locale)}
          </p>
          <ActionButton label={t('mobile.fill.contents')} decorative />
        </div>
        <div
          role="progressbar"
          aria-label={progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressFraction(view) * 100)}
          className="h-2 overflow-hidden rounded-full bg-surface-muted"
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${String(Math.round(progressFraction(view) * 100))}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-sm text-content-muted">
          <span>{progressLabel}</span>
          <span>{t('mobile.fill.saved')}</span>
        </div>
      </header>

      <div className="h-[40rem] overflow-y-auto px-4 pb-16 pt-4">
        <div className="flex flex-col gap-4">
          {problems.length === 0 ? null : (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-lg border-[1.5px] border-danger bg-danger-subtle p-4"
            >
              <p className="text-lg font-bold">
                {t('fill.summary.title', { count: problems.length })}
              </p>
              {problems.map((problem) => (
                <button
                  key={touchKey(problem.field, problem.entry)}
                  type="button"
                  className="min-h-11 text-start text-base font-semibold text-danger underline"
                  onClick={() => {
                    const index = pageIndexOfField(pages, problem.field);
                    goTo(index === -1 ? current : index);
                    const section = form.elements.get(problem.field)?.entries;
                    if (problem.entry !== undefined && section !== undefined) {
                      setOpen({ section, entry: problem.entry });
                    }
                  }}
                >
                  {t('fill.summary.goTo', { question: questionName(form, problem.field, locale) })}
                </button>
              ))}
            </div>
          )}

          {reviewing ? (
            <div data-part="review" className="flex flex-col gap-4">
              <p className="text-2xl font-bold">{t('fill.review.title')}</p>
              <Muted>{t('fill.review.intro')}</Muted>
              <div className="flex justify-between gap-3">
                <ActionButton label={t('fill.actions.edit')} onPress={() => goTo(current)} />
                <ActionButton tone="primary" label={t('fill.actions.submit')} disabled />
              </div>
            </div>
          ) : page === undefined ? null : (
            <div data-page={page.id} className="flex flex-col gap-4">
              <div>
                {pages.length > 1 ? (
                  <Muted>
                    {t('mobile.fill.pageOf', { number: current + 1, total: pages.length })}
                  </Muted>
                ) : null}
                {pages.length > 1 || page.title !== undefined ? (
                  <p className="text-2xl font-bold">
                    {say(page.title, locale) || t('fill.nav.page', { number: current + 1 })}
                  </p>
                ) : null}
                <Description text={page.description} locale={locale} of="page" />
              </div>

              {openEntry === undefined ? null : (
                <EntryView
                  {...props}
                  section={sectionById(form, openEntry.section)!}
                  entryId={openEntry.entry}
                  onOpen={setOpen}
                />
              )}

              {openEntry !== undefined
                ? null
                : page.sections
                    .filter((section) => view.visible.get(section.id) === true)
                    .map((section) => (
                      <div
                        key={section.id}
                        data-section={section.id}
                        data-repeat={section.repeat === undefined ? undefined : ''}
                        className="flex flex-col gap-5 rounded-lg border border-border-subtle bg-surface p-4"
                      >
                        {section.title === undefined ? null : (
                          <p data-part="section-title" className="text-lg font-bold">
                            {say(section.title, locale)}
                          </p>
                        )}
                        <Description text={section.description} locale={locale} of="section" />
                        {section.repeat === undefined ? (
                          section.fields
                            .filter((field) => view.visible.get(field.id) === true)
                            .map((field) =>
                              isInformation(field) ? (
                                <InformationBlock key={field.id} item={field} locale={locale} />
                              ) : (
                                <Question
                                  key={field.id}
                                  {...props}
                                  field={field}
                                  value={
                                    view.values.get(field.id) ?? ownAnswer(state.answers, field.id)
                                  }
                                  errors={view.shownErrors.filter(
                                    (error) =>
                                      error.field === field.id && error.entry === undefined,
                                  )}
                                  required={isRequiredNow(view, field)}
                                  choices={dependentChoices(form, view, field, locale)}
                                  entry={undefined}
                                />
                              ),
                            )
                        ) : (
                          <EntryList {...props} section={section} onOpen={setOpen} />
                        )}
                      </div>
                    ))}

              {openEntry !== undefined ? null : (
                <div className="flex justify-between gap-3">
                  <ActionButton
                    label={t('fill.actions.back')}
                    disabled={current === 0}
                    onPress={() => goTo(current - 1)}
                  />
                  {current < pages.length - 1 ? (
                    <ActionButton
                      tone="primary"
                      label={t('fill.actions.next')}
                      onPress={() => goTo(current + 1)}
                    />
                  ) : (
                    <ActionButton
                      tone="primary"
                      label={t('fill.actions.review')}
                      onPress={review}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Frame>
  );
}

/** The phone's frame: its outline, status bar, direction, colours and font. */
function Frame({
  locale,
  brand,
  children,
}: {
  locale: string;
  brand: PhoneBrand;
  children: ReactNode;
}) {
  return (
    <div
      dir={isRtl(locale) ? 'rtl' : 'ltr'}
      lang={locale}
      style={phoneStyle(brand)}
      className="mx-auto flex w-[24.5rem] max-w-full flex-col overflow-hidden rounded-[2.75rem] border-[10px] border-[#0b0f19] bg-background text-start text-content shadow-xl"
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-between bg-surface px-6 pb-1 pt-2 text-xs font-semibold text-content"
      >
        <span dir="ltr">9:41</span>
        <span className="h-5 w-24 rounded-full bg-[#0b0f19]" />
        <span dir="ltr">5G ▮</span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text that is not a question (form format 2), as the phone draws it
// ---------------------------------------------------------------------------

/** An Information block: plain, or boxed with a coloured edge for a tip or a warning. */
function InformationBlock({ item, locale }: { item: Information; locale: string }) {
  const { t } = useTranslation();
  const { heading, lines, style } = informationText(item, locale);
  return (
    <div
      role={style === 'warning' ? 'note' : undefined}
      data-information={item.id}
      data-style={style}
      className={[
        'flex flex-col gap-1',
        style === 'plain' ? '' : 'rounded-md border-s-4 p-3',
        style === 'tip' ? 'border-accent bg-accent-subtle' : '',
        style === 'warning' ? 'border-warning bg-warning-subtle' : '',
      ].join(' ')}
    >
      {style === 'plain' ? null : <span className="sr-only">{t(`fill.information.${style}`)}</span>}
      {heading === undefined ? null : (
        <p data-part="information-heading" className="text-base font-semibold">
          {heading}
        </p>
      )}
      <p data-part="information-body" className="whitespace-pre-line text-base">
        {lines.join('\n')}
      </p>
    </div>
  );
}

/** A page's or section's description, under its title. Nothing when it has none. */
function Description({
  text,
  locale,
  of,
}: {
  text: LocalizedText | undefined;
  locale: string;
  of: 'page' | 'section';
}) {
  const said = say(text, locale).trim();
  return said === '' ? null : (
    <p data-part={`${of}-description`} className="whitespace-pre-line text-sm text-content-muted">
      {said}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Repeating sections: a list of entries, then one entry at a time
// ---------------------------------------------------------------------------

type OnOpen = (open: { section: string; entry: string } | undefined) => void;

function EntryList(props: PhonePreviewProps & { section: Section; onOpen: OnOpen }) {
  const { section, view, locale, onEvent, onOpen, newEntryId } = props;
  const { t } = useTranslation();
  const entries = entriesOf(view, section.id);
  return (
    <div className="flex flex-col gap-2">
      {entries.length === 0 ? <Muted>{t('mobile.fill.entries.none')}</Muted> : null}
      {entries.map((entry, index) => {
        const title = titleOf(section, entry, index, locale);
        const problems = firstPerField(entryErrors(view.shownErrors, entry.id)).length;
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onOpen({ section: section.id, entry: entry.id })}
            className={[
              'flex min-h-14 items-center gap-2 rounded-md border-[1.5px] bg-background px-3 py-2 text-start',
              problems > 0 ? 'border-danger' : 'border-border-strong',
            ].join(' ')}
          >
            <span data-part="entry-title" className="flex-1 text-lg font-semibold">
              {title}
            </span>
            {problems === 0 ? null : (
              <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-sm font-semibold text-danger">
                {t('fill.nav.problems', { count: problems })}
              </span>
            )}
            <span aria-hidden="true" className="text-2xl text-content-muted">
              {isRtl(locale) ? '‹' : '›'}
            </span>
          </button>
        );
      })}
      {sectionErrors(view.shownErrors, section.id).map((error) => (
        <p key={error.code} data-part="section-problem" className="text-sm text-danger">
          {translateError(t, error)}
        </p>
      ))}
      {canAddEntry(section, view) ? (
        <ActionButton
          label={t('mobile.fill.entries.add', { entry: say(section.repeat?.entryLabel, locale) })}
          onPress={() => {
            const entry = (newEntryId ?? (() => crypto.randomUUID()))();
            onEvent({ type: 'add_entry', section: section.id, entry });
            onOpen({ section: section.id, entry });
          }}
        />
      ) : (
        <Muted>{t('mobile.fill.entries.full', { count: section.repeat?.maxEntries ?? 0 })}</Muted>
      )}
    </div>
  );
}

function EntryView(
  props: PhonePreviewProps & { section: Section; entryId: string; onOpen: OnOpen },
) {
  const { form, state, view, locale, section, entryId, onEvent, onOpen } = props;
  const { t } = useTranslation();
  const entries = entriesOf(view, section.id);
  const index = entries.findIndex((entry) => entry.id === entryId);
  const entry = entries[index];
  if (entry === undefined) {
    return null;
  }
  const stored = storedEntries(state.answers, section.id).find((e) => e.id === entryId);
  const go = (next: number) => {
    const target = entries[next];
    if (target !== undefined) {
      onOpen({ section: section.id, entry: target.id });
    }
  };
  return (
    <div data-entry={entryId} className="flex flex-col gap-4">
      <div>
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.entries.back', {
            section: say(section.title, locale) || say(section.repeat?.entryLabel, locale),
          })}
          onPress={() => onOpen(undefined)}
        />
      </div>
      <div>
        <Muted>
          {t('mobile.fill.entries.position', { number: index + 1, total: entries.length })}
        </Muted>
        <p className="text-2xl font-bold">{titleOf(section, entry, index, locale)}</p>
      </div>
      <div className="flex flex-col gap-5 rounded-lg border border-border-subtle bg-surface p-4">
        {section.fields
          .filter((field) => entry.visible.get(field.id) === true)
          .map((field) =>
            isInformation(field) ? (
              <InformationBlock key={field.id} item={field} locale={locale} />
            ) : (
              <Question
                key={field.id}
                {...props}
                field={field}
                value={entry.values.get(field.id) ?? stored?.values[field.id]}
                errors={view.shownErrors.filter(
                  (error) => error.field === field.id && error.entry === entryId,
                )}
                required={isRequiredNow(view, field, entryId)}
                choices={dependentChoices(form, view, field, locale, entryId)}
                entry={entryId}
              />
            ),
          )}
      </div>
      <div className="flex flex-wrap justify-between gap-3">
        <ActionButton
          label={t('mobile.fill.entries.previous')}
          disabled={index === 0}
          onPress={() => go(index - 1)}
        />
        {index < entries.length - 1 ? (
          <ActionButton
            tone="primary"
            label={t('mobile.fill.entries.next')}
            onPress={() => go(index + 1)}
          />
        ) : (
          <ActionButton
            tone="primary"
            label={t('mobile.fill.entries.done')}
            onPress={() => onOpen(undefined)}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-3">
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.entries.moveUp')}
          disabled={index === 0}
          onPress={() =>
            onEvent({ type: 'move_entry', section: section.id, entry: entryId, index: index - 1 })
          }
        />
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.entries.moveDown')}
          disabled={index === entries.length - 1}
          onPress={() =>
            onEvent({ type: 'move_entry', section: section.id, entry: entryId, index: index + 1 })
          }
        />
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.entries.remove')}
          onPress={() => {
            onEvent({ type: 'remove_entry', section: section.id, entry: entryId });
            onOpen(undefined);
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

interface QuestionProps extends PhonePreviewProps {
  field: Field;
  value: unknown;
  errors: readonly FieldError[];
  required: boolean;
  choices: DependentChoices | undefined;
  entry: string | undefined;
}

function Question(props: QuestionProps) {
  const { field, value, errors, required, choices, locale, entry, onEvent } = props;
  const { t } = useTranslation();
  const label = say(field.label, locale) || field.id;
  const inEntry = entry === undefined ? {} : { entry };
  const answer = (next: unknown) =>
    onEvent({ type: 'answer', field: field.id, value: next, ...inEntry });
  const touch = () => onEvent({ type: 'touch', field: field.id, ...inEntry });
  const mark = required ? (
    <span data-part="required" className="text-danger">
      {' *'}
    </span>
  ) : null;
  const heading = (
    <p data-part="label" className="text-lg font-semibold">
      {label}
      {mark}
    </p>
  );
  const help =
    field.help === undefined ? null : (
      <p data-part="help" className="text-sm text-content-muted">
        {say(field.help, locale)}
      </p>
    );
  const messages =
    errors.length === 0 ? null : (
      <div aria-live="polite" className="flex flex-col gap-1">
        {errors.map((error) => (
          <p
            key={`${error.code}-${error.params.rule ?? ''}`}
            data-part="error"
            className="text-base font-semibold text-danger"
          >
            {errorMessage(field, error, locale, t as unknown as Translate)}
          </p>
        ))}
      </div>
    );

  if (isCalculated(field)) {
    return (
      <div
        data-question={field.id}
        className="flex flex-col gap-2 border-s-[3px] border-transparent ps-3"
      >
        {heading}
        {help}
        <p data-part="calculated" className="rounded-md bg-surface-muted p-3 text-lg">
          {calculatedText(field, value, locale) || '—'}
          {'unit' in field && field.unit !== undefined && value !== undefined
            ? ` ${field.unit}`
            : ''}
        </p>
        <Muted>{t('fill.calculated')}</Muted>
      </div>
    );
  }

  const noChoices =
    choices === undefined || choices.options.length > 0 ? null : (
      <Muted>
        {choices.parentAnswered
          ? t('fill.dependsOn.none', { parent: choices.parentLabel })
          : t('fill.dependsOn.chooseFirst', { parent: choices.parentLabel })}
      </Muted>
    );

  return (
    <div
      data-question={field.id}
      className={[
        'flex flex-col gap-2 border-s-[3px] ps-3',
        errors.length > 0 ? 'border-danger' : 'border-transparent',
      ].join(' ')}
    >
      {field.type === 'checkbox' ? null : heading}
      {help}
      <Control
        {...props}
        label={label}
        mark={mark}
        disabled={field.readOnly === true}
        invalid={errors.length > 0}
        answer={answer}
        touch={touch}
        clear={() => onEvent({ type: 'clear', field: field.id, ...inEntry })}
      />
      {noChoices}
      {messages}
    </div>
  );
}

type Translate = (key: string, params: Record<string, string>) => string;

function Control(
  props: QuestionProps & {
    label: string;
    mark: ReactNode;
    disabled: boolean;
    invalid: boolean;
    answer: (value: unknown) => void;
    touch: () => void;
    clear: () => void;
  },
) {
  const { field, value, label, mark, disabled, invalid, choices, locale, answer, touch, clear } =
    props;
  const { t } = useTranslation();
  const box = [
    'min-h-14 w-full rounded-md border-[1.5px] bg-surface px-3 py-3 text-start text-lg text-content placeholder:text-content-muted disabled:bg-surface-muted',
    invalid ? 'border-danger' : 'border-border-strong',
  ].join(' ');
  const text = typeof value === 'string' ? value : '';

  switch (field.type) {
    case 'text':
    case 'long_text':
      return (
        <div className="flex flex-col gap-2">
          {field.type === 'long_text' ? (
            <textarea
              aria-label={label}
              className={`${box} min-h-28`}
              disabled={disabled}
              value={text}
              onChange={(event) => answer(event.target.value)}
              onBlur={touch}
            />
          ) : (
            <input
              aria-label={label}
              className={box}
              disabled={disabled}
              value={text}
              onChange={(event) => answer(event.target.value)}
              onBlur={touch}
            />
          )}
          {disabled ? null : <Muted>{t('mobile.fill.dictation')}</Muted>}
        </div>
      );
    case 'barcode':
      return (
        <div className="flex items-center gap-2">
          <input
            aria-label={label}
            className={box}
            disabled={disabled}
            value={text}
            onChange={(event) => answer(event.target.value)}
            onBlur={touch}
          />
          {disabled ? null : <ActionButton label={t('mobile.fill.barcode.scan')} decorative />}
        </div>
      );
    case 'number':
    case 'decimal':
      return (
        <div className="flex items-center gap-2">
          <input
            aria-label={label}
            inputMode="decimal"
            className={box}
            disabled={disabled}
            value={
              field.type === 'number' ? (typeof value === 'number' ? String(value) : '') : text
            }
            onChange={(event) => {
              const typed = event.target.value;
              if (field.type === 'decimal') {
                answer(typed);
              } else {
                answer(typed === '' ? '' : Number.parseInt(typed, 10));
              }
            }}
            onBlur={touch}
          />
          {field.unit === undefined ? null : (
            <span className="text-lg text-content-muted">{field.unit}</span>
          )}
        </div>
      );
    case 'date':
    case 'time':
    case 'datetime':
      return (
        <input
          aria-label={label}
          type={field.type === 'datetime' ? 'datetime-local' : field.type}
          className={box}
          disabled={disabled}
          value={field.type === 'datetime' ? text.slice(0, 16) : text}
          onChange={(event) =>
            answer(
              field.type === 'datetime' && event.target.value !== ''
                ? `${event.target.value}:00${offset(event.target.value)}`
                : event.target.value,
            )
          }
          onBlur={touch}
        />
      );
    case 'dropdown':
      return (
        <select
          aria-label={label}
          className={box}
          disabled={disabled}
          value={text}
          onChange={(event) => answer(event.target.value)}
          onBlur={touch}
        >
          <option value="">{t('fill.choose')}</option>
          {offeredOptions(field.options, choices?.options).map((option) => (
            <option key={option.value} value={option.value}>
              {say(option.label, locale)}
            </option>
          ))}
        </select>
      );
    case 'radio':
      return (
        <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
          {offeredOptions(field.options, choices?.options).map((option) => (
            <ChoiceRow
              key={option.value}
              role="radio"
              label={say(option.label, locale)}
              selected={value === option.value}
              disabled={disabled}
              onPress={() => {
                answer(option.value);
                touch();
              }}
            />
          ))}
        </div>
      );
    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div role="group" aria-label={label} className="flex flex-col gap-2">
          {offeredOptions(field.options, choices?.options).map((option) => {
            const ticked = selected.includes(option.value);
            return (
              <ChoiceRow
                key={option.value}
                role="checkbox"
                label={say(option.label, locale)}
                selected={ticked}
                disabled={disabled}
                onPress={() => {
                  answer(
                    toggleOffered(field.options, choices?.options, selected, option.value, !ticked),
                  );
                  touch();
                }}
              />
            );
          })}
        </div>
      );
    }
    case 'checkbox':
      return (
        <ChoiceRow
          role="checkbox"
          label={label}
          mark={mark}
          isQuestion
          selected={value === true}
          disabled={disabled}
          onPress={() => {
            answer(value !== true);
            touch();
          }}
        />
      );
    case 'yes_no':
    case 'rating': {
      const choices =
        field.type === 'yes_no'
          ? [
              { value: 'yes' as unknown, label: t('fill.yes') },
              { value: 'no' as unknown, label: t('fill.no') },
              ...(field.allowNotApplicable === true
                ? [{ value: 'not_applicable' as unknown, label: t('fill.notApplicable') }]
                : []),
            ]
          : Array.from({ length: field.scale }, (_, index) => ({
              value: index + 1,
              label: String(index + 1),
            }));
      return (
        <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <button
              key={String(choice.value)}
              type="button"
              role="radio"
              aria-checked={value === choice.value}
              disabled={disabled}
              onClick={() => {
                answer(choice.value);
                touch();
              }}
              className={[
                'min-h-14 min-w-14 grow rounded-md border-[1.5px] px-3 text-lg font-semibold disabled:opacity-60',
                value === choice.value
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border-strong bg-surface text-content',
              ].join(' ')}
            >
              {choice.label}
            </button>
          ))}
        </div>
      );
    }
    case 'signature':
    case 'photo':
    case 'file':
    case 'gps':
      return (
        <div className="flex flex-col gap-2">
          <Muted>
            {value === undefined || isAnswered(field, value) === false
              ? t('forms.preview.onDevice')
              : t('forms.preview.simulated')}
          </Muted>
          {disabled ? null : value !== undefined && isAnswered(field, value) ? (
            <ActionButton label={t('forms.preview.clear')} onPress={clear} />
          ) : (
            <ActionButton
              label={t('forms.preview.simulate')}
              onPress={() => answer(simulated(field))}
            />
          )}
        </div>
      );
  }
}

/** Photos, files, signatures and locations come from the device; the preview makes one up. */
function simulated(field: Field): unknown {
  const media = { mediaId: crypto.randomUUID(), contentType: 'image/jpeg', byteSize: 120_000 };
  switch (field.type) {
    case 'signature':
      return { ...media, contentType: 'image/png' };
    case 'photo':
      return [media];
    case 'file':
      return [
        {
          ...media,
          contentType: field.acceptedTypes?.[0]?.replace('*', 'jpeg') ?? 'application/pdf',
        },
      ];
    default:
      return { latitude: '30.0444', longitude: '31.2357', accuracyMeters: '5' };
  }
}

// ---------------------------------------------------------------------------
// The phone's pieces, drawn in the DOM (apps/mobile/src/forms/widgets/kit.tsx)
// ---------------------------------------------------------------------------

function ChoiceRow({
  role,
  label,
  mark,
  isQuestion = false,
  selected,
  disabled,
  onPress,
}: {
  role: 'radio' | 'checkbox';
  label: string;
  mark?: ReactNode;
  /** A tick box that is the whole question: its words are the question's. */
  isQuestion?: boolean;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      onClick={onPress}
      className={[
        'flex min-h-14 w-full items-center gap-3 rounded-md border-[1.5px] px-3 py-2 text-start disabled:opacity-60',
        selected ? 'border-accent bg-accent-subtle' : 'border-border-subtle bg-surface',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'flex size-7 shrink-0 items-center justify-center border-2',
          role === 'radio' ? 'rounded-full' : 'rounded-sm',
          selected ? 'border-accent' : 'border-border-strong',
          selected && role === 'checkbox' ? 'bg-accent text-on-accent' : '',
        ].join(' ')}
      >
        {selected && role === 'radio' ? <span className="size-3.5 rounded-full bg-accent" /> : null}
        {selected && role === 'checkbox' ? <span className="text-lg font-bold">✓</span> : null}
      </span>
      <span
        {...(isQuestion ? { 'data-part': 'label' } : {})}
        className="flex-1 text-lg text-content"
      >
        {label}
        {mark}
      </span>
    </button>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  decorative = false,
  tone = 'secondary',
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  /** Drawn for the look only (the phone's own back and contents buttons): not a control here. */
  decorative?: boolean;
  tone?: 'primary' | 'secondary' | 'quiet';
}) {
  const className = [
    'flex min-h-14 items-center justify-center rounded-md border-[1.5px] px-4 py-2 text-base font-semibold disabled:opacity-60',
    tone === 'primary'
      ? 'border-accent bg-accent text-on-accent'
      : tone === 'quiet'
        ? 'border-transparent bg-transparent text-accent'
        : 'border-border-strong bg-surface text-content',
  ].join(' ');
  if (decorative) {
    return (
      <span aria-hidden="true" className={className}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" disabled={disabled} onClick={onPress} className={className}>
      {label}
    </button>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-content-muted">{children}</p>;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "Radiator 2 · Hall", as the phone lists an entry. */
function titleOf(section: Section, entry: EntryEvaluation, index: number, locale: string): string {
  const title = entryTitle(section, entry, index, locale);
  return title.name === undefined ? title.label : `${title.label} · ${title.name}`;
}

function questionName(form: CompiledForm, id: string, locale: string): string {
  const field = form.elements.get(id)?.field;
  if (field !== undefined) {
    return say(field.label, locale) || field.id;
  }
  const section = sectionById(form, id);
  return say(section?.title, locale) || say(section?.repeat?.entryLabel, locale) || id;
}

function sectionById(form: CompiledForm, id: string): Section | undefined {
  return form.definition.pages
    .flatMap((page) => page.sections)
    .find((section) => section.id === id);
}

function translateError(t: ReturnType<typeof useTranslation>['t'], error: FieldError): string {
  // One key chosen at run time from the engine's codes, as the phone does.
  const translate = t as unknown as Translate;
  return translate(`form.errors.${error.code}`, { ...error.params });
}

/** `+03:00` for a local date and time on this device, which the engine requires. */
function offset(local: string): string {
  const minutes = -new Date(local).getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  return `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}
