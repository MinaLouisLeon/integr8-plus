import { useTranslation } from '@integr8/i18n';
import { useId, useState } from 'react';
import { Button } from '~/components/ui';
import { session } from '~/lib/session';
import { uploadMedia } from '~/lib/media-upload';
import type { LocalizedText, Question } from './designer-model';

/**
 * The PDF designer's inputs: labelled, compact, and each changing one value.
 * Written for the designer's narrow column rather than taken from the app's
 * full-width form fields.
 */

const inputClass =
  'w-full rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-start text-sm text-content';
const labelClass = 'text-xs font-medium text-content-muted';

export function TextInput({
  label,
  value,
  onChange,
  multiline = false,
  dir,
  maxLength,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  dir?: 'ltr' | 'rtl' | 'auto';
  maxLength?: number;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={`${inputClass} min-h-20`}
          dir={dir}
          maxLength={maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className={inputClass}
          dir={dir}
          maxLength={maxLength}
          value={value}
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-content-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The English and the Arabic of one text, side by side. */
export function LocalizedInputs({
  labels,
  value,
  onChange,
  multiline = false,
  optional = false,
}: {
  labels: { en: string; ar: string };
  value: LocalizedText | undefined;
  onChange: (value: LocalizedText | undefined) => void;
  multiline?: boolean;
  optional?: boolean;
}) {
  // A language left empty is left out: the format takes one language or both, never an empty one.
  const set = (language: 'en' | 'ar', text: string) => {
    const next: LocalizedText = { ...(value ?? {}) };
    if (text === '') {
      delete next[language];
    } else {
      next[language] = text;
    }
    onChange(optional && Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      <TextInput
        label={labels.en}
        value={value?.en ?? ''}
        dir="ltr"
        multiline={multiline}
        maxLength={2000}
        onChange={(text) => set('en', text)}
      />
      <TextInput
        label={labels.ar}
        value={value?.ar ?? ''}
        dir="rtl"
        multiline={multiline}
        maxLength={2000}
        onChange={(text) => set('ar', text)}
      />
    </div>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  step?: number;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        className={inputClass}
        min={min}
        max={max}
        step={step}
        value={value ?? ''}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => {
          const text = event.target.value;
          if (text === '') {
            onChange(null);
            return;
          }
          const number = Number(text);
          if (Number.isFinite(number)) {
            onChange(Math.min(max, Math.max(min, number)));
          }
        }}
      />
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-content-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectInput<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string;
  value: T | '';
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {placeholder === undefined ? null : (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CheckInput({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-content">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** A question picker: the form's questions of the kinds a block can show. */
export function QuestionInput({
  label,
  value,
  questions,
  locale,
  onChange,
}: {
  label: string;
  value: string;
  questions: readonly Question[];
  locale: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const language = locale.startsWith('ar') ? 'ar' : 'en';
  return (
    <SelectInput
      label={label}
      value={value}
      placeholder={t('documents.designer.block.choose')}
      options={questions.map((question) => ({
        value: question.id,
        label: `${question.label[language] ?? question.label.en ?? question.id} (${question.id})`,
      }))}
      onChange={onChange}
    />
  );
}

/** Image types a template accepts; the server checks again. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_MAX_BYTES = 10_000_000;

/**
 * Uploading a picture for a template: a background or a picture block. The
 * file goes to the company's bucket like any upload; saving the template
 * ties it to the template.
 */
export function ImageUpload({
  label,
  fileId,
  onChange,
  removable = true,
  hint,
}: {
  label: string;
  fileId: string | null;
  onChange: (fileId: string | null) => void;
  removable?: boolean;
  /** Instead of the general hint: a background's pixel size for the page's orientation. */
  hint?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={id}
          className="cursor-pointer rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content hover:bg-surface-muted"
        >
          {busy
            ? t('documents.designer.page.uploading')
            : fileId === null
              ? t('documents.designer.page.upload')
              : t('documents.designer.page.replace')}
        </label>
        <input
          id={id}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file === undefined) {
              return;
            }
            if (!IMAGE_TYPES.includes(file.type) || file.size > IMAGE_MAX_BYTES) {
              setFailed(true);
              return;
            }
            setBusy(true);
            setFailed(false);
            uploadMedia(session().client, file)
              .then((uploaded) => onChange(uploaded))
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        />
        {fileId !== null && removable ? (
          <Button variant="ghost" onClick={() => onChange(null)}>
            {t('documents.designer.page.remove')}
          </Button>
        ) : null}
      </div>
      <p className={failed ? 'text-xs text-danger' : 'text-xs text-content-muted'}>
        {hint ?? t('documents.designer.page.imageHint')}
      </p>
    </div>
  );
}
