import { useTranslation } from '@integr8/i18n';
import { type ReactNode, useState } from 'react';
import { offeredOptions, readDecimal, readInteger, toggleOffered } from '@integr8/form-input';
import { say, withLocalOffset } from '../text.js';
import { inputClass, type WidgetProps } from './types.js';

/**
 * The questions a native input answers well: text, numbers, dates and times,
 * choices, a tick box, a rating.
 *
 * Native controls throughout, because they arrive with keyboard support, screen
 * reader semantics and platform pickers that no hand-built control matches —
 * and because a field engineer's browser already knows how to use them.
 */

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function TextWidget(props: WidgetProps<'text' | 'barcode'>) {
  const { field, value, id, describedBy, invalid, required, disabled, onAnswer, onBlur } = props;
  return (
    <input
      id={id}
      type="text"
      value={text(value)}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      aria-required={required}
      maxLength={field.maxLength}
      // A barcode is usually typed by a scanner acting as a keyboard: no
      // autocorrect, no capitalisation, nothing that would rewrite a serial.
      {...(field.type === 'barcode'
        ? { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
        : {})}
      onChange={(event) => onAnswer(event.target.value)}
      onBlur={onBlur}
      className={inputClass}
    />
  );
}

export function LongTextWidget(props: WidgetProps<'long_text'>) {
  const { field, value, id, describedBy, invalid, required, disabled, onAnswer, onBlur } = props;
  return (
    <textarea
      id={id}
      rows={4}
      value={text(value)}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      aria-required={required}
      maxLength={field.maxLength}
      onChange={(event) => onAnswer(event.target.value)}
      onBlur={onBlur}
      className={inputClass}
    />
  );
}

function WithUnit({ unit, children }: { unit: string | undefined; children: ReactNode }) {
  return unit === undefined ? (
    <>{children}</>
  ) : (
    <div className="flex items-center gap-2">
      {children}
      <span className="shrink-0 text-sm text-content-muted">{unit}</span>
    </div>
  );
}

/**
 * A whole number. The answer is an integer, but what is typed passes through
 * states that are not one — "-" on the way to "-5" — so the text is kept here
 * until it is a number, and shown as typed rather than snapped back.
 */
export function NumberWidget(props: WidgetProps<'number'>) {
  const { field, value, id, describedBy, invalid, required, disabled, onAnswer, onBlur } = props;
  const [typing, setTyping] = useState<string | undefined>(undefined);
  const stored = typeof value === 'number' ? String(value) : '';
  const shown = typing ?? stored;
  const unfinished = typing !== undefined && typing !== '' && !/^-?\d+$/u.test(typing);
  return (
    <WithUnit unit={field.unit}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={shown}
        disabled={disabled}
        aria-invalid={invalid || unfinished}
        aria-describedby={describedBy}
        aria-required={required}
        onChange={(event) => {
          const typed = readInteger(event.target.value);
          setTyping(typed.text);
          if (typed.answer !== undefined) {
            onAnswer(typed.answer);
          }
        }}
        onBlur={() => {
          if (!unfinished) {
            setTyping(undefined);
          }
          onBlur();
        }}
        className={inputClass}
      />
    </WithUnit>
  );
}

export function DecimalWidget(props: WidgetProps<'decimal'>) {
  const { field, value, id, describedBy, invalid, required, disabled, onAnswer, onBlur } = props;
  return (
    <WithUnit unit={field.unit}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text(value)}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-required={required}
        onChange={(event) => onAnswer(readDecimal(event.target.value))}
        onBlur={onBlur}
        className={inputClass}
      />
    </WithUnit>
  );
}

export function TemporalWidget(props: WidgetProps<'date' | 'time' | 'datetime'>) {
  const { field, value, id, describedBy, invalid, required, disabled, onAnswer, onBlur } = props;
  const datetime = field.type === 'datetime';
  return (
    <input
      id={id}
      type={datetime ? 'datetime-local' : field.type}
      value={datetime ? text(value).slice(0, 16) : text(value)}
      min={datetime ? field.earliest?.slice(0, 16) : field.earliest}
      max={datetime ? field.latest?.slice(0, 16) : field.latest}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      aria-required={required}
      onChange={(event) =>
        onAnswer(
          datetime && event.target.value !== ''
            ? withLocalOffset(event.target.value)
            : event.target.value,
        )
      }
      onBlur={onBlur}
      className={`${inputClass} w-auto`}
    />
  );
}

export function DropdownWidget(props: WidgetProps<'dropdown'>) {
  const {
    field,
    value,
    id,
    describedBy,
    invalid,
    required,
    available,
    disabled,
    locale,
    onAnswer,
    onBlur,
  } = props;
  const { t } = useTranslation();
  return (
    <select
      id={id}
      value={text(value)}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      aria-required={required}
      onChange={(event) => onAnswer(event.target.value)}
      onBlur={onBlur}
      className={inputClass}
    >
      <option value="">{t('fill.choose')}</option>
      {offeredOptions(field.options, available).map((option) => (
        <option key={option.value} value={option.value}>
          {say(option.label, locale)}
        </option>
      ))}
    </select>
  );
}

interface Choice {
  value: string;
  label: string;
}

/** A radio group. Arrow keys move between options, as in every native radio group. */
function RadioGroup({
  props,
  choices,
  inline,
}: {
  props: Pick<WidgetProps, 'id' | 'value' | 'disabled' | 'onAnswer' | 'onBlur'>;
  choices: readonly Choice[];
  inline: boolean;
}) {
  const { id, value, disabled, onAnswer, onBlur } = props;
  return (
    <div className={inline ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}>
      {choices.map((choice) => (
        <label
          key={choice.value}
          className={[
            'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm text-content',
            value === choice.value
              ? 'border-accent bg-accent-subtle'
              : 'border-border-subtle bg-surface',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
          ].join(' ')}
        >
          <input
            type="radio"
            name={id}
            value={choice.value}
            checked={value === choice.value}
            disabled={disabled}
            onChange={() => onAnswer(choice.value)}
            onBlur={onBlur}
          />
          {choice.label}
        </label>
      ))}
    </div>
  );
}

export function RadioWidget(props: WidgetProps<'radio'>) {
  return (
    <RadioGroup
      props={props}
      inline={false}
      choices={offeredOptions(props.field.options, props.available).map((option) => ({
        value: option.value,
        label: say(option.label, props.locale),
      }))}
    />
  );
}

export function YesNoWidget(props: WidgetProps<'yes_no'>) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      props={props}
      inline
      choices={[
        { value: 'yes', label: t('fill.yes') },
        { value: 'no', label: t('fill.no') },
        ...(props.field.allowNotApplicable === true
          ? [{ value: 'not_applicable', label: t('fill.notApplicable') }]
          : []),
      ]}
    />
  );
}

export function MultiSelectWidget(props: WidgetProps<'multi_select'>) {
  const { field, value, disabled, invalid, available, locale, onAnswer, onBlur } = props;
  const selected = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div className="flex flex-col gap-2">
      {offeredOptions(field.options, available).map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-center gap-2 text-sm text-content"
        >
          <input
            type="checkbox"
            checked={selected.includes(option.value)}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) =>
              onAnswer(
                toggleOffered(
                  field.options,
                  available,
                  selected,
                  option.value,
                  event.target.checked,
                ),
              )
            }
            onBlur={onBlur}
          />
          {say(option.label, locale)}
        </label>
      ))}
    </div>
  );
}

/** A tick box is its own label: "I have isolated the gas supply." */
export function CheckboxWidget(props: WidgetProps<'checkbox'>) {
  const { value, id, label, describedBy, invalid, required, disabled, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-content">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={value === true}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-required={required}
        onChange={(event) => onAnswer(event.target.checked)}
        onBlur={onBlur}
      />
      <span className="font-medium">
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="text-danger">
              {' *'}
            </span>
            <span className="sr-only">{` (${t('fill.required')})`}</span>
          </>
        ) : null}
      </span>
    </label>
  );
}

/**
 * A rating, as a radio group styled as buttons: arrow keys choose, and a screen
 * reader says "4 out of 5, 4 of 5" rather than "button".
 */
export function RatingWidget(props: WidgetProps<'rating'>) {
  const { field, value, id, disabled, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: field.scale }, (_, index) => index + 1).map((score) => (
        <label
          key={score}
          className={[
            'flex size-10 cursor-pointer items-center justify-center rounded-md border text-sm font-medium',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
            value === score
              ? 'border-accent bg-accent text-on-accent'
              : 'border-border-subtle bg-surface text-content hover:bg-surface-muted',
          ].join(' ')}
        >
          <input
            type="radio"
            name={id}
            className="sr-only"
            value={score}
            checked={value === score}
            disabled={disabled}
            aria-label={t('fill.rating', { value: score, scale: field.scale })}
            onChange={() => onAnswer(score)}
            onBlur={onBlur}
          />
          <span aria-hidden="true">{score}</span>
        </label>
      ))}
    </div>
  );
}
