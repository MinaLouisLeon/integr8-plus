import {
  type EntryEvaluation,
  type Field,
  type FieldError,
  type FormEvent,
  type FormView,
  isAnswered,
  isCalculated,
  type Section,
} from '@integr8/form-engine';
import {
  canAddEntry,
  entriesOf,
  entryErrors,
  entryTitle,
  removingLeavesTooFew,
  sectionErrors,
} from '@integr8/form-input';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { say } from './text.js';
import { buttonClass } from './widgets/types.js';

/**
 * A repeatable section, filled in: its questions once per appliance, radiator or
 * defect, as a list of entries a person can add to, remove from and reorder
 * (P13b).
 *
 * Controlled, like the rest of the engine's renderers: the entries come from the
 * view and every change goes out as an event. The field controls are the
 * caller's, so the web renderer and the builder's preview list entries the same
 * way while each keeps its own widgets.
 *
 * Everything a mouse does here a keyboard does too, and every change is said
 * aloud: adding, removing and moving an entry are announced in a live region,
 * and focus goes where the person's attention is — the new entry's first
 * question, the entry that took a removed one's place, the button just pressed.
 */

export interface EntryFieldContext {
  entry: EntryEvaluation;
  /** The entry's place in the list, from 0. */
  index: number;
  /** Ids for this entry's controls start with this, so two entries never share one. */
  prefix: string;
  /** The errors to show on this question in this entry. */
  errors: FieldError[];
}

export interface EntryListProps {
  section: Section;
  view: FormView;
  locale: string;
  /** Unique to this renderer on the page. */
  prefix: string;
  onEvent: (event: FormEvent) => void;
  /** Makes the id of an added entry. A UUID unless a test says otherwise. */
  newEntryId?: (() => string) | undefined;
  /** Show the entries without accepting changes. */
  disabled?: boolean | undefined;
  /** The level of each entry's heading, one below the section's. */
  headingLevel?: 3 | 4 | 5 | 6 | undefined;
  renderField: (field: Field, context: EntryFieldContext) => ReactNode;
}

/** The id of an entry's heading, which focus can move to. */
export const entryHeadingId = (prefix: string, entry: string) => `${prefix}-${entry}-title`;

/** The prefix for the controls of one entry. */
export const entryPrefix = (prefix: string, entry: string) => `${prefix}-${entry}`;

/** The id of the element holding a section's own problems, which the problem list links to. */
export const sectionProblemsId = (prefix: string, section: string) =>
  `${prefix}-section-${section}-problems`;

/** "Appliance 2 · Worcester", or "Appliance 2" before the naming question is answered. */
export function entryName(
  section: Section,
  entry: EntryEvaluation,
  index: number,
  locale: string,
  t: TFunction,
): string {
  const title = entryTitle(section, entry, index, locale);
  return title.name === undefined
    ? title.label
    : t('fill.entries.named', { label: title.label, name: title.name });
}

/** What a repeatable section is called beside its own problems: its title, or what one entry is. */
export function sectionName(section: Section, locale: string): string {
  return say(section.title, locale) || say(section.repeat?.entryLabel, locale) || section.id;
}

/** The words for a problem on the section itself: too few or too many entries. */
export function SectionProblem({ section, error, locale }: SectionProblemProps) {
  const { t } = useTranslation();
  // One key chosen at run time from the engine's codes, as `ErrorText` does.
  const translate = t as unknown as (key: string, options: Record<string, string>) => string;
  return (
    <>
      {t('fill.entries.sectionProblem', {
        section: sectionName(section, locale),
        problem: translate(`form.errors.${error.code}`, { ...error.params }),
      })}
    </>
  );
}

interface SectionProblemProps {
  section: Section;
  error: FieldError;
  locale: string;
}

type Pending =
  { kind: 'entry'; entry: string } | { kind: 'id'; id: string; fallback?: string | undefined };

export function EntryList({
  section,
  view,
  locale,
  prefix,
  onEvent,
  newEntryId = () => crypto.randomUUID(),
  disabled = false,
  headingLevel = 5,
  renderField,
}: EntryListProps) {
  const { t } = useTranslation();
  const entries = entriesOf(view, section.id);
  const [announcement, setAnnouncement] = useState('');
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const pending = useRef<Pending | undefined>(undefined);
  const addId = `${prefix}-section-${section.id}-add`;
  const problems = sectionErrors(view.shownErrors, section.id);
  const repeat = section.repeat;

  // Focus moves once the change it follows has rendered.
  useEffect(() => {
    const target = pending.current;
    if (target === undefined) {
      return;
    }
    pending.current = undefined;
    if (target.kind === 'entry') {
      const group = document.getElementById(`${entryPrefix(prefix, target.entry)}-fields`);
      const control = group?.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
      );
      (control ?? document.getElementById(entryHeadingId(prefix, target.entry)))?.focus();
      return;
    }
    const element = document.getElementById(target.id) as HTMLButtonElement | null;
    if (element !== null && !element.disabled) {
      element.focus();
    } else if (target.fallback !== undefined) {
      document.getElementById(target.fallback)?.focus();
    }
  });

  if (repeat === undefined) {
    return null;
  }

  const add = () => {
    const id = newEntryId();
    onEvent({ type: 'add_entry', section: section.id, entry: id });
    pending.current = { kind: 'entry', entry: id };
    setAnnouncement(
      t('fill.entries.added', {
        entry: `${say(repeat.entryLabel, locale)} ${new Intl.NumberFormat(locale).format(entries.length + 1)}`,
      }),
    );
  };

  const remove = (index: number) => {
    const entry = entries[index]!;
    const name = entryName(section, entry, index, locale, t);
    onEvent({ type: 'remove_entry', section: section.id, entry: entry.id });
    setConfirming(undefined);
    const next = entries[index + 1] ?? entries[index - 1];
    pending.current =
      next === undefined
        ? { kind: 'id', id: addId }
        : { kind: 'id', id: entryHeadingId(prefix, next.id) };
    setAnnouncement(t('fill.entries.removed', { entry: name }));
  };

  const move = (index: number, delta: -1 | 1) => {
    const entry = entries[index]!;
    const to = index + delta;
    onEvent({ type: 'move_entry', section: section.id, entry: entry.id, index: to });
    const own = entryPrefix(prefix, entry.id);
    pending.current = {
      kind: 'id',
      id: `${own}-${delta < 0 ? 'up' : 'down'}`,
      fallback: `${own}-${delta < 0 ? 'down' : 'up'}`,
    };
    setAnnouncement(
      t('fill.entries.moved', {
        entry: entryName(section, entry, to, locale, t),
        position: to + 1,
        total: entries.length,
      }),
    );
  };

  /** Changing one's mind about removing: back to the button that asked. */
  const keep = (entry: string) => {
    setConfirming(undefined);
    pending.current = { kind: 'id', id: `${entryPrefix(prefix, entry)}-remove` };
  };

  const hasAnswers = (entry: EntryEvaluation) =>
    section.fields.some(
      (field) => !isCalculated(field) && isAnswered(field, entry.values.get(field.id)),
    );

  const tooFew = removingLeavesTooFew(section, view);
  const Heading = `h${String(headingLevel)}` as 'h5';

  return (
    <div className="flex flex-col gap-4">
      {problems.length === 0 ? null : (
        <ul
          id={sectionProblemsId(prefix, section.id)}
          tabIndex={-1}
          className="flex flex-col gap-0.5 outline-none"
        >
          {problems.map((error) => (
            <li key={error.code} className="text-sm font-medium text-danger">
              <SectionProblem section={section} error={error} locale={locale} />
            </li>
          ))}
        </ul>
      )}

      {entries.length === 0 ? (
        <p className="text-sm text-content-muted">{t('fill.entries.none')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {entries.map((entry, index) => {
            const own = entryPrefix(prefix, entry.id);
            const name = entryName(section, entry, index, locale, t);
            const errors = entryErrors(view.shownErrors, entry.id);
            const problemCount = new Set(errors.map((error) => error.field)).size;
            return (
              <li key={entry.id}>
                <div
                  role="group"
                  aria-labelledby={entryHeadingId(prefix, entry.id)}
                  className={[
                    'flex flex-col gap-4 rounded-md border bg-surface p-3 sm:p-4',
                    errors.length > 0 ? 'border-danger' : 'border-border-subtle',
                  ].join(' ')}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Heading
                        id={entryHeadingId(prefix, entry.id)}
                        tabIndex={-1}
                        className="text-sm font-semibold text-content outline-none"
                      >
                        {name}
                      </Heading>
                      {problemCount === 0 ? null : (
                        <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-xs text-danger">
                          {t('fill.nav.problems', { count: problemCount })}
                        </span>
                      )}
                    </div>
                    {disabled ? null : (
                      <div className="flex shrink-0 flex-wrap gap-1">
                        <button
                          id={`${own}-up`}
                          type="button"
                          className={buttonClass.ghost}
                          aria-label={t('fill.entries.moveUp', { entry: name })}
                          title={t('fill.entries.moveUp', { entry: name })}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <span aria-hidden="true">↑</span>
                        </button>
                        <button
                          id={`${own}-down`}
                          type="button"
                          className={buttonClass.ghost}
                          aria-label={t('fill.entries.moveDown', { entry: name })}
                          title={t('fill.entries.moveDown', { entry: name })}
                          disabled={index === entries.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <span aria-hidden="true">↓</span>
                        </button>
                        <button
                          id={`${own}-remove`}
                          type="button"
                          className={buttonClass.ghost}
                          aria-label={t('fill.entries.removeEntry', { entry: name })}
                          disabled={tooFew}
                          onClick={() => {
                            if (hasAnswers(entry)) {
                              setConfirming(entry.id);
                              pending.current = { kind: 'id', id: `${own}-confirm` };
                            } else {
                              remove(index);
                            }
                          }}
                        >
                          {t('fill.entries.remove')}
                        </button>
                      </div>
                    )}
                  </div>

                  {confirming === entry.id && !disabled ? (
                    <div className="flex flex-col gap-2 rounded-md border border-danger bg-danger-subtle p-3">
                      <p id={`${own}-confirm-question`} className="text-sm text-content">
                        {t('fill.entries.removeQuestion', { entry: name })}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          id={`${own}-confirm`}
                          type="button"
                          className={buttonClass.primary}
                          aria-describedby={`${own}-confirm-question`}
                          onClick={() => remove(index)}
                          onKeyDown={(event) => event.key === 'Escape' && keep(entry.id)}
                        >
                          {t('fill.entries.confirmRemove')}
                        </button>
                        <button
                          type="button"
                          className={buttonClass.secondary}
                          onClick={() => keep(entry.id)}
                          onKeyDown={(event) => event.key === 'Escape' && keep(entry.id)}
                        >
                          {t('fill.entries.keep')}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div id={`${own}-fields`} className="flex flex-col gap-5">
                    {section.fields
                      .filter((field) => entry.visible.get(field.id) === true)
                      .map((field) =>
                        renderField(field, {
                          entry,
                          index,
                          prefix: own,
                          errors: errors.filter((error) => error.field === field.id),
                        }),
                      )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {disabled ? null : (
        <div className="flex flex-wrap items-center gap-3">
          {canAddEntry(section, view) ? (
            <button id={addId} type="button" className={buttonClass.secondary} onClick={add}>
              {`+ ${t('fill.entries.add', { entry: say(repeat.entryLabel, locale) })}`}
            </button>
          ) : (
            <p className="text-sm text-content-muted">
              {t('fill.entries.limit', { maximum: repeat.maxEntries })}
            </p>
          )}
          {(repeat.minEntries ?? 0) > 0 ? (
            <p className="text-xs text-content-muted">
              {t('fill.entries.minimum', { minimum: repeat.minEntries ?? 0 })}
            </p>
          ) : null}
        </div>
      )}

      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
