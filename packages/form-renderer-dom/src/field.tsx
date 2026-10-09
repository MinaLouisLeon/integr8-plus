import {
  type Field,
  type FieldError,
  formatDecimal,
  isCalculated,
  parseDecimal,
} from '@integr8/form-engine';
import { type DependentChoices, errorMessage } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import type { ReactNode } from 'react';
import type { MediaAdapter } from './media.js';
import { say } from './text.js';
import {
  CheckboxWidget,
  DecimalWidget,
  DropdownWidget,
  LongTextWidget,
  MultiSelectWidget,
  NumberWidget,
  RadioWidget,
  RatingWidget,
  TemporalWidget,
  TextWidget,
  YesNoWidget,
} from './widgets/basic.js';
import { FilesWidget } from './widgets/files.js';
import { GpsWidget } from './widgets/gps.js';
import { SignatureWidget } from './widgets/signature.js';
import { isGroup, type WidgetProps } from './widgets/types.js';

/** The id of a question's control, from the filler's prefix. What the error summary links to. */
export const controlId = (prefix: string, field: string) => `${prefix}-${field}`;

export interface FieldBlockProps {
  field: Field;
  value: unknown;
  errors: readonly FieldError[];
  prefix: string;
  locale: string;
  media: MediaAdapter | undefined;
  disabled: boolean;
  /**
   * Whether it must be answered right now, from the view — `required`, or a
   * `requiredWhen` that holds. Defaults to the definition's fixed `required`.
   */
  required?: boolean | undefined;
  /** For a choice whose options depend on another answer: what is on offer, and which question decides. */
  choices?: DependentChoices | undefined;
  onAnswer: (value: unknown) => void;
  onClear: () => void;
  onBlur: () => void;
}

/**
 * One question: its label, help, control and errors, wired so assistive
 * technology announces them together.
 *
 * A question answered with a single control is a `<label>`; one answered with a
 * group of controls is a `<fieldset>` named by its `<legend>`. Help and errors
 * are joined to the control with `aria-describedby`, so a screen reader reads
 * "Pressure, edit text, must be no more than 10" in one breath.
 */
export function FieldBlock(props: FieldBlockProps) {
  const {
    field,
    value,
    errors,
    prefix,
    locale,
    media,
    disabled,
    choices,
    onAnswer,
    onClear,
    onBlur,
  } = props;
  const isRequired = props.required ?? field.required === true;
  const { t } = useTranslation();
  const id = controlId(prefix, field.id);
  const label = say(field.label, locale) || field.id;
  const helpId = field.help === undefined ? undefined : `${id}-help`;
  const errorsId = errors.length === 0 ? undefined : `${id}-errors`;
  // Nothing to choose from until the question this one depends on is answered.
  const choicesId = choices?.options.length === 0 ? `${id}-choices` : undefined;
  const describedBy =
    [helpId, choicesId, errorsId].filter((part) => part !== undefined).join(' ') || undefined;

  const required = isRequired ? (
    <>
      <span aria-hidden="true" className="text-danger">
        {' *'}
      </span>
      <span className="sr-only">{` (${t('fill.required')})`}</span>
    </>
  ) : null;

  const help =
    field.help === undefined ? null : (
      <p id={helpId} className="text-xs text-content-muted">
        {say(field.help, locale)}
      </p>
    );

  const noChoices =
    choices === undefined || choicesId === undefined ? null : (
      <p id={choicesId} className="text-xs text-content-muted">
        {choices.parentAnswered
          ? t('fill.dependsOn.none', { parent: choices.parentLabel })
          : t('fill.dependsOn.chooseFirst', { parent: choices.parentLabel })}
      </p>
    );

  const messages =
    errors.length === 0 ? null : (
      <ul id={errorsId} className="flex flex-col gap-0.5">
        {errors.map((error) => (
          <li
            key={`${error.code}-${error.params.rule ?? ''}`}
            className="text-xs font-medium text-danger"
          >
            <ErrorText field={field} error={error} locale={locale} />
          </li>
        ))}
      </ul>
    );

  if (isCalculated(field)) {
    return (
      <div className="flex flex-col gap-1.5" data-question={field.id}>
        <span id={`${id}-label`} className="text-sm font-medium text-content">
          {label}
        </span>
        {help}
        <output
          id={id}
          aria-labelledby={`${id}-label`}
          aria-live="polite"
          className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content"
        >
          {calculatedText(field, value) || '—'}
          {'unit' in field && field.unit !== undefined && value !== undefined
            ? ` ${field.unit}`
            : ''}
        </output>
        <p className="text-xs text-content-muted">{t('fill.calculated')}</p>
      </div>
    );
  }

  const widgetProps: WidgetProps = {
    field,
    value,
    id,
    label,
    describedBy,
    invalid: errors.length > 0,
    required: isRequired,
    available: choices?.options,
    disabled: disabled || field.readOnly === true,
    locale,
    media,
    onAnswer,
    onClear,
    onBlur,
  };

  const control = widget(widgetProps);

  if (field.type === 'checkbox') {
    return (
      <div className="flex flex-col gap-1.5" data-question={field.id}>
        {control}
        {help}
        {messages}
      </div>
    );
  }

  if (isGroup(field)) {
    return (
      <fieldset
        className="flex min-w-0 flex-col gap-2"
        data-question={field.id}
        aria-describedby={describedBy}
        {...(field.type === 'radio' ||
        field.type === 'yes_no' ||
        field.type === 'rating' ||
        field.type === 'multi_select'
          ? { id, tabIndex: -1 }
          : {})}
        {...(errors.length > 0 ? { 'aria-invalid': true } : {})}
      >
        <legend className="mb-1 text-sm font-medium text-content">
          {label}
          {required}
        </legend>
        {help}
        {control}
        {noChoices}
        {messages}
      </fieldset>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-question={field.id}>
      <label htmlFor={id} className="text-sm font-medium text-content">
        {label}
        {required}
      </label>
      {help}
      {control}
      {noChoices}
      {messages}
    </div>
  );
}

function widget(props: WidgetProps): ReactNode {
  switch (props.field.type) {
    case 'text':
    case 'barcode':
      return <TextWidget {...(props as WidgetProps<'text' | 'barcode'>)} />;
    case 'long_text':
      return <LongTextWidget {...(props as WidgetProps<'long_text'>)} />;
    case 'number':
      return <NumberWidget {...(props as WidgetProps<'number'>)} />;
    case 'decimal':
      return <DecimalWidget {...(props as WidgetProps<'decimal'>)} />;
    case 'date':
    case 'time':
    case 'datetime':
      return <TemporalWidget {...(props as WidgetProps<'date' | 'time' | 'datetime'>)} />;
    case 'dropdown':
      return <DropdownWidget {...(props as WidgetProps<'dropdown'>)} />;
    case 'radio':
      return <RadioWidget {...(props as WidgetProps<'radio'>)} />;
    case 'multi_select':
      return <MultiSelectWidget {...(props as WidgetProps<'multi_select'>)} />;
    case 'checkbox':
      return <CheckboxWidget {...(props as WidgetProps<'checkbox'>)} />;
    case 'yes_no':
      return <YesNoWidget {...(props as WidgetProps<'yes_no'>)} />;
    case 'rating':
      return <RatingWidget {...(props as WidgetProps<'rating'>)} />;
    case 'signature':
      return <SignatureWidget {...(props as WidgetProps<'signature'>)} />;
    case 'photo':
    case 'file':
      return <FilesWidget {...(props as WidgetProps<'photo' | 'file'>)} />;
    case 'gps':
      return <GpsWidget {...(props as WidgetProps<'gps'>)} />;
  }
}

function calculatedText(field: Field, value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (field.type === 'decimal' && typeof value === 'string') {
    const parsed = parseDecimal(value);
    return parsed === undefined ? value : formatDecimal(parsed);
  }
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

/** A rule's own message when it has one; the catalogue's otherwise, with the engine's parameters. */
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
  // One key chosen at run time from the engine's codes; the i18n package's test
  // holds that every code has a message and every parameter is one the engine sends.
  const translate = t as unknown as (key: string, options: Record<string, string>) => string;
  return <>{errorMessage(field, error, locale, translate)}</>;
}
