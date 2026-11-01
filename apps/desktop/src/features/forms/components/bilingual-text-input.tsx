import { type LocalizedText, withLanguage } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useId } from 'react';

/**
 * One text a form shows, typed in English and Arabic side by side.
 *
 * Whatever language the builder itself is in, both boxes are there: a form is
 * filled in whichever language each engineer's phone is set to, so a text with
 * only one of them shows that one to everybody (owner's decision, 1.3.0). The
 * Arabic box is right-to-left. Any other language the text already holds is
 * kept as it is.
 *
 * Emptying a box removes that language rather than storing `""`, which the
 * definition refuses. When both are empty `onChange` receives `undefined`: an
 * optional text (help, a section title) is then removed, and a required one is
 * stored as the caller decides (a label stays `{}`, which the compiler names).
 *
 * Shared by every editor in the settings panel, and meant for any new kind of
 * text the builder learns to edit.
 */

export const FORM_LANGUAGES = ['en', 'ar'] as const;
export type FormLanguage = (typeof FORM_LANGUAGES)[number];

export interface BilingualTextInputProps {
  label: string;
  value: Readonly<Record<string, string>> | undefined;
  onChange: (value: LocalizedText | undefined) => void;
  /** After a box loses focus: a question's key follows its English wording then. */
  onBlur?: ((language: FormLanguage) => void) | undefined;
  multiline?: boolean;
  /** In English: shown in the English box only. */
  placeholder?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  /** The definition allows 2,000 characters per language. */
  maxLength?: number | undefined;
  /** Hides the label visually, for a row whose heading already says what it is. */
  hideLabel?: boolean;
}

export function BilingualTextInput({
  label,
  value,
  onChange,
  onBlur,
  multiline = false,
  placeholder,
  hint,
  error,
  maxLength = 2_000,
  hideLabel = false,
}: BilingualTextInputProps) {
  const { t } = useTranslation();
  const id = useId();
  const describedBy =
    error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-1">
      <span
        id={`${id}-label`}
        className={hideLabel ? 'sr-only' : 'text-sm font-medium text-content'}
      >
        {label}
      </span>
      <div className="grid grid-cols-2 gap-2">
        {FORM_LANGUAGES.map((language) => {
          const inputId = `${id}-${language}`;
          const missing = language === 'ar' && (value?.ar ?? '').trim() === '' && hasOther(value);
          const className = [
            'w-full rounded-md border bg-surface px-2 py-1.5 text-start text-sm text-content',
            error !== undefined
              ? 'border-danger'
              : missing
                ? 'border-warning'
                : 'border-border-subtle',
          ].join(' ');
          const common = {
            id: inputId,
            // "Question · Arabic": the box says which text and which language in one name.
            'aria-label': `${label} · ${t(`forms.bilingual.${language}`)}`,
            dir: language === 'ar' ? ('rtl' as const) : ('ltr' as const),
            lang: language,
            maxLength,
            value: value?.[language] ?? '',
            placeholder:
              language === 'ar'
                ? missing
                  ? t('forms.bilingual.missingArabic')
                  : undefined
                : placeholder,
            'aria-describedby': describedBy,
            'aria-invalid': error !== undefined,
            onBlur: () => onBlur?.(language),
            className,
          };
          return (
            <div key={language} className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={inputId} className="text-xs text-content-muted">
                {t(`forms.bilingual.${language}`)}
              </label>
              {multiline ? (
                <textarea
                  {...common}
                  rows={2}
                  onChange={(event) => onChange(withLanguage(value, language, event.target.value))}
                />
              ) : (
                <input
                  {...common}
                  type="text"
                  onChange={(event) => onChange(withLanguage(value, language, event.target.value))}
                />
              )}
            </div>
          );
        })}
      </div>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-content-muted">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Whether the text says something in a language other than Arabic. */
function hasOther(value: Readonly<Record<string, string>> | undefined): boolean {
  return Object.entries(value ?? {}).some(
    ([language, text]) => language !== 'ar' && text.trim() !== '',
  );
}
