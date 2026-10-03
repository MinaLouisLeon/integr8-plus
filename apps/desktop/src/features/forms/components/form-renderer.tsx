import {
  type CompiledForm,
  type EntryEvaluation,
  type Field,
  type FieldError,
  type FormEvent,
  type FormState,
  type FormView,
  isCalculated,
  ownAnswer,
  storedEntries,
} from '@integr8/form-engine';
import { EntryList } from '@integr8/form-renderer-dom';
import { useTranslation } from '@integr8/i18n';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '~/components/ui';
import { say } from '../model/text';

/**
 * A form, filled in — the builder's preview and test fill.
 *
 * It holds no rules of its own. Visibility, calculated values and errors all
 * come from the engine's `viewForm`, the same function the phone and the web
 * renderer use, so the preview shows what an engineer will see rather than a
 * builder's approximation of it.
 *
 * `phone` shows one page at a time in a single column, the way a field engineer
 * moves through a form; `desktop` shows every page at once.
 *
 * A repeatable section lists its entries with the web renderer's own list, so
 * adding, removing and reordering them behaves here as it will for the person
 * filling the form in (P13b).
 */

export interface FormRendererProps {
  form: CompiledForm;
  state: FormState;
  view: FormView;
  onEvent: (event: FormEvent) => void;
  viewport: 'desktop' | 'phone';
  locale: string;
  /** Show the controls without accepting input — a past version, a template. */
  readOnly?: boolean;
  /** Makes the id of an added entry. A UUID unless a test says otherwise. */
  newEntryId?: (() => string) | undefined;
}

export function FormRenderer(props: FormRendererProps) {
  const { form, view, viewport, locale, onEvent, readOnly = false, newEntryId } = props;
  const { t } = useTranslation();
  const prefix = useId().replaceAll(':', '');
  const pages = form.definition.pages.filter((page) => view.visible.get(page.id) === true);
  const [pageIndex, setPageIndex] = useState(0);
  const current = Math.min(pageIndex, Math.max(pages.length - 1, 0));
  const shown = viewport === 'phone' ? pages.slice(current, current + 1) : pages;

  return (
    <div className="flex flex-col gap-6 text-start">
      <h2 className="text-xl font-semibold text-content">{say(form.definition.title, locale)}</h2>

      {view.progress.requiredTotal > 0 ? (
        <p className="text-xs text-content-muted">
          {t('forms.preview.progress', {
            answered: view.progress.requiredAnswered,
            total: view.progress.requiredTotal,
          })}
        </p>
      ) : null}

      {shown.map((page) => (
        <div key={page.id} className="flex flex-col gap-6">
          {page.title === undefined ? null : (
            <h3 className="text-lg font-semibold text-content">{say(page.title, locale)}</h3>
          )}
          {page.sections
            .filter((section) => view.visible.get(section.id) === true)
            .map((section) => (
              <fieldset
                key={section.id}
                className="flex flex-col gap-5 rounded-lg border border-border-subtle bg-surface p-4"
              >
                {section.title === undefined ? null : (
                  <legend className="px-1 text-sm font-semibold text-content">
                    {say(section.title, locale)}
                  </legend>
                )}
                {section.repeat === undefined ? (
                  section.fields
                    .filter((field) => view.visible.get(field.id) === true)
                    .map((field) => <FieldControl key={field.id} {...props} field={field} />)
                ) : (
                  <EntryList
                    section={section}
                    view={view}
                    locale={locale}
                    prefix={prefix}
                    onEvent={onEvent}
                    newEntryId={newEntryId}
                    disabled={readOnly}
                    headingLevel={4}
                    renderField={(field, { entry, errors }) => (
                      <FieldControl
                        key={field.id}
                        {...props}
                        field={field}
                        entry={entry}
                        entryErrors={errors}
                      />
                    )}
                  />
                )}
              </fieldset>
            ))}
        </div>
      ))}

      {viewport === 'phone' && pages.length > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            disabled={current === 0}
            onClick={() => setPageIndex(current - 1)}
          >
            {t('forms.preview.back')}
          </Button>
          <span className="text-xs text-content-muted">
            {t('forms.preview.pageOf', { current: current + 1, total: pages.length })}
          </span>
          <Button
            variant="secondary"
            disabled={current >= pages.length - 1}
            onClick={() => setPageIndex(current + 1)}
          >
            {t('forms.preview.next')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FieldControl(
  props: FormRendererProps & {
    field: Field;
    /** For a question of a repeatable section: the entry it is answered in, and its errors there. */
    entry?: EntryEvaluation | undefined;
    entryErrors?: readonly FieldError[] | undefined;
  },
) {
  const { field, state, view, onEvent, locale, readOnly = false, entry, entryErrors } = props;
  const { t } = useTranslation();
  const id = useId();
  const errors =
    entryErrors ??
    view.shownErrors.filter((error) => error.field === field.id && error.entry === undefined);
  const calculated = isCalculated(field);
  const disabled = readOnly || calculated || field.readOnly === true;
  const stored =
    entry === undefined
      ? state.answers
      : (storedEntries(state.answers, sectionOf(props)).find(
          (candidate) => candidate.id === entry.id,
        )?.values ?? {});
  const value = calculated
    ? (entry?.values ?? view.values).get(field.id)
    : ownAnswer(stored, field.id);
  const inEntry = entry === undefined ? {} : { entry: entry.id };

  const answer = (next: unknown) =>
    onEvent({ type: 'answer', field: field.id, value: next, ...inEntry });
  const touch = () => onEvent({ type: 'touch', field: field.id, ...inEntry });
  const describedBy = errors.length > 0 ? `${id}-errors` : field.help ? `${id}-help` : undefined;

  const common = {
    id,
    disabled,
    onBlur: touch,
    'aria-invalid': errors.length > 0,
    'aria-describedby': describedBy,
    className:
      'w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start text-sm text-content disabled:opacity-70',
  };

  let control: ReactNode;
  switch (field.type) {
    case 'text':
    case 'barcode':
      control = (
        <input
          {...common}
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => answer(event.target.value)}
        />
      );
      break;
    case 'long_text':
      control = (
        <textarea
          {...common}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => answer(event.target.value)}
        />
      );
      break;
    case 'number':
      control = (
        <UnitWrap unit={field.unit}>
          <input
            {...common}
            type="number"
            step={1}
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) =>
              answer(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10))
            }
          />
        </UnitWrap>
      );
      break;
    case 'decimal':
      control = (
        <UnitWrap unit={field.unit}>
          <input
            {...common}
            type="text"
            inputMode="decimal"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => answer(event.target.value)}
          />
        </UnitWrap>
      );
      break;
    case 'date':
    case 'time':
      control = (
        <input
          {...common}
          type={field.type}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => answer(event.target.value)}
        />
      );
      break;
    case 'datetime':
      control = (
        <input
          {...common}
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          onChange={(event) =>
            answer(event.target.value === '' ? '' : withLocalOffset(event.target.value))
          }
        />
      );
      break;
    case 'dropdown':
      control = (
        <select
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => answer(event.target.value)}
        >
          <option value="">{t('forms.preview.choose')}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {say(option.label, locale)}
            </option>
          ))}
        </select>
      );
      break;
    case 'radio':
    case 'yes_no': {
      const options =
        field.type === 'radio'
          ? field.options.map((option) => ({
              value: option.value,
              label: say(option.label, locale),
            }))
          : [
              { value: 'yes', label: t('forms.config.yes') },
              { value: 'no', label: t('forms.config.no') },
              ...(field.allowNotApplicable === true
                ? [{ value: 'not_applicable', label: t('forms.config.notApplicable') }]
                : []),
            ];
      control = (
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          className={field.type === 'yes_no' ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}
        >
          {options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-content">
              <input
                type="radio"
                name={id}
                disabled={disabled}
                checked={value === option.value}
                onChange={() => answer(option.value)}
                onBlur={touch}
              />
              {option.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          className="flex flex-col gap-2"
        >
          {field.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.includes(option.value)}
                onChange={(event) =>
                  answer(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((candidate) => candidate !== option.value),
                  )
                }
                onBlur={touch}
              />
              {say(option.label, locale)}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'checkbox':
      control = (
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            id={id}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => answer(event.target.checked)}
            onBlur={touch}
            aria-describedby={describedBy}
          />
          {say(field.label, locale)}
        </label>
      );
      break;
    case 'rating':
      control = (
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          className="flex flex-wrap gap-1"
          aria-describedby={describedBy}
        >
          {Array.from({ length: field.scale }, (_, index) => index + 1).map((score) => (
            <button
              key={score}
              type="button"
              role="radio"
              aria-checked={value === score}
              disabled={disabled}
              onClick={() => answer(score)}
              onBlur={touch}
              className={[
                'size-9 rounded-md border text-sm',
                value === score
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border-subtle bg-surface text-content',
              ].join(' ')}
            >
              {score}
            </button>
          ))}
        </div>
      );
      break;
    case 'signature':
    case 'photo':
    case 'file':
    case 'gps':
      control = (
        <DeviceCapture
          field={field}
          value={value}
          disabled={disabled}
          onAnswer={answer}
          onClear={() => onEvent({ type: 'clear', field: field.id, ...inEntry })}
        />
      );
      break;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {field.type === 'checkbox' ? null : (
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-content">
          {say(field.label, locale)}
          {field.required === true ? (
            <span aria-hidden="true" className="text-danger">
              {' *'}
            </span>
          ) : null}
        </label>
      )}
      {field.help === undefined ? null : (
        <p id={`${id}-help`} className="text-xs text-content-muted">
          {say(field.help, locale)}
        </p>
      )}
      {control}
      {calculated ? (
        <p className="text-xs text-content-muted">{t('forms.preview.calculated')}</p>
      ) : null}
      {errors.length === 0 ? null : (
        <ul id={`${id}-errors`} role="alert" className="flex flex-col gap-0.5">
          {errors.map((error) => (
            <li key={`${error.code}-${error.params.rule ?? ''}`} className="text-xs text-danger">
              <ErrorText field={field} error={error} locale={locale} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The repeatable section a field of the form is asked in. */
function sectionOf(props: FormRendererProps & { field: Field }): string {
  return props.form.elements.get(props.field.id)?.entries ?? '';
}

/** A rule's own message when it has one; the catalogue's otherwise. */
export function ErrorText({
  field,
  error,
  locale,
}: {
  field: Field;
  error: FieldError;
  locale: string;
}) {
  const { t } = useTranslation();
  if (error.code === 'rule_failed') {
    const rule = field.rules?.find((candidate) => candidate.id === error.params.rule);
    if (rule !== undefined) {
      return <>{say(rule.message, locale)}</>;
    }
  }
  // The engine sends a different parameter set per code, which the typed catalogue cannot
  // relate to one key chosen at run time. The i18n package's test checks every code has a
  // message and every parameter is one the engine sends.
  const translate = t as unknown as (key: string, options: Record<string, string>) => string;
  return <>{translate(`form.errors.${error.code}`, { ...error.params })}</>;
}

function UnitWrap({ unit, children }: { unit: string | undefined; children: ReactNode }) {
  if (unit === undefined) {
    return <>{children}</>;
  }
  return (
    <div className="flex items-center gap-2">
      {children}
      <span className="text-sm text-content-muted">{unit}</span>
    </div>
  );
}

/**
 * Photos, files, signatures and locations are captured by the device, which a
 * builder's preview is not. Test fill simulates one, so a required photo does
 * not make every test fail.
 */
function DeviceCapture({
  field,
  value,
  disabled,
  onAnswer,
  onClear,
}: {
  field: Field;
  value: unknown;
  disabled: boolean;
  onAnswer: (value: unknown) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const has = value !== undefined;

  const simulate = () => {
    const media = { mediaId: crypto.randomUUID(), contentType: 'image/jpeg', byteSize: 120_000 };
    switch (field.type) {
      case 'signature':
        onAnswer({ ...media, contentType: 'image/png' });
        break;
      case 'photo':
        onAnswer([media]);
        break;
      case 'file':
        onAnswer([
          {
            ...media,
            contentType: field.acceptedTypes?.[0]?.replace('*', 'jpeg') ?? 'application/pdf',
          },
        ]);
        break;
      case 'gps':
        onAnswer({ latitude: '30.0444', longitude: '31.2357', accuracyMeters: '5' });
        break;
      default:
        break;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border-subtle px-3 py-3 text-sm text-content-muted">
      <span>{has ? t('forms.preview.simulated') : t('forms.preview.onDevice')}</span>
      {disabled ? null : has ? (
        <Button variant="ghost" onClick={onClear}>
          {t('forms.preview.clear')}
        </Button>
      ) : (
        <Button variant="secondary" onClick={simulate}>
          {t('forms.preview.simulate')}
        </Button>
      )}
    </div>
  );
}

/** `2026-09-13T14:05` from a date-time input, with this device's offset, which the engine requires. */
export function withLocalOffset(local: string): string {
  const offset = -new Date(local).getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${local}:00${sign}${hours}:${minutes}`;
}
