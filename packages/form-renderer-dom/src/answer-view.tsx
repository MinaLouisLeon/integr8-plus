import {
  type Answers,
  type CompiledForm,
  evaluateForm,
  type Field,
  geoPointSchema,
  isAnswered,
  mediaReferenceSchema,
  ownAnswer,
} from '@integr8/form-engine';
import { formatDate, formatDateTime, formatList, useTranslation } from '@integr8/i18n';
import type { ReactNode } from 'react';
import type { MediaAdapter } from './media.js';
import { formatBytes, say } from './text.js';
import { MediaImage, useMediaUrl } from './widgets/media-image.js';
import { buttonClass } from './widgets/types.js';

/**
 * Answers, read-only, against the version they were given to.
 *
 * What a submission detail shows, what each entry in its history shows, and
 * what the review screen shows before submitting. Only questions visible for
 * these answers are listed — the same evaluation the form used — so a
 * submission from version 1 reads exactly as it did the day it was made,
 * however many versions have been published since.
 */
export interface AnswerViewProps {
  form: CompiledForm;
  answers: Answers;
  locale: string;
  media?: MediaAdapter | undefined;
  today?: string | undefined;
  /** Answers to compare with: a question whose answer differs is marked as changed. */
  previous?: Answers | undefined;
  /** Offers a "Change" button per page. */
  onChangePage?: ((pageIndex: number) => void) | undefined;
}

export function AnswerView({
  form,
  answers,
  locale,
  media,
  today,
  previous,
  onChangePage,
}: AnswerViewProps) {
  const { t } = useTranslation();
  const { visible, values } = evaluateForm(form, answers, today === undefined ? {} : { today });
  const pages = form.definition.pages.filter((page) => visible.get(page.id) === true);

  return (
    <div className="flex flex-col gap-6 text-start">
      {pages.map((page, pageIndex) => (
        <section
          key={page.id}
          aria-label={say(page.title, locale) || t('fill.nav.page', { number: pageIndex + 1 })}
          className="flex flex-col gap-4"
        >
          {pages.length > 1 || page.title !== undefined || onChangePage !== undefined ? (
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-content">
                {say(page.title, locale) || t('fill.nav.page', { number: pageIndex + 1 })}
              </h3>
              {onChangePage === undefined ? null : (
                <button
                  type="button"
                  className={buttonClass.ghost}
                  onClick={() => onChangePage(form.definition.pages.indexOf(page))}
                >
                  {t('fill.actions.change')}
                </button>
              )}
            </div>
          ) : null}
          {page.sections
            .filter((section) => visible.get(section.id) === true)
            .map((section) => (
              <div key={section.id} className="flex flex-col gap-2">
                {section.title === undefined ? null : (
                  <h4 className="text-sm font-semibold text-content-muted">
                    {say(section.title, locale)}
                  </h4>
                )}
                <dl className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
                  {section.fields
                    .filter((field) => visible.get(field.id) === true)
                    .map((field) => {
                      const value = values.get(field.id);
                      const changed =
                        previous !== undefined &&
                        JSON.stringify(ownAnswer(previous, field.id) ?? null) !==
                          JSON.stringify(ownAnswer(answers, field.id) ?? null);
                      return (
                        <div
                          key={field.id}
                          className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4"
                        >
                          <dt className="text-sm text-content-muted">
                            {say(field.label, locale) || field.id}
                            {changed ? (
                              <span className="ms-2 rounded-full bg-warning-subtle px-2 py-0.5 text-xs text-content">
                                {t('submissions.detail.changed')}
                              </span>
                            ) : null}
                          </dt>
                          <dd className="min-w-0 text-sm text-content">
                            <AnswerValue
                              field={field}
                              value={value}
                              locale={locale}
                              media={media}
                            />
                          </dd>
                        </div>
                      );
                    })}
                </dl>
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}

function AnswerValue({
  field,
  value,
  locale,
  media,
}: {
  field: Field;
  value: unknown;
  locale: string;
  media: MediaAdapter | undefined;
}): ReactNode {
  const { t } = useTranslation();
  const label = say(field.label, locale) || field.id;

  if (!isAnswered(field, value)) {
    return <span className="text-content-muted">{t('fill.unanswered')}</span>;
  }

  switch (field.type) {
    case 'text':
    case 'barcode':
      return String(value);
    case 'long_text':
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
    case 'number':
    case 'decimal':
      return `${String(value)}${field.unit === undefined ? '' : ` ${field.unit}`}`;
    case 'date':
      return formatDate(`${String(value)}T12:00:00Z`, { locale, timeZone: 'UTC' });
    case 'time':
      return String(value);
    case 'datetime':
      return formatDateTime(String(value), { locale });
    case 'dropdown':
    case 'radio': {
      const option = field.options.find((candidate) => candidate.value === value);
      return option === undefined ? String(value) : say(option.label, locale);
    }
    case 'multi_select':
      return formatList(
        (value as string[]).map((chosen) => {
          const option = field.options.find((candidate) => candidate.value === chosen);
          return option === undefined ? chosen : say(option.label, locale);
        }),
        { locale },
      );
    case 'checkbox':
      return value === true ? t('fill.ticked') : t('fill.notTicked');
    case 'yes_no':
      return value === 'yes'
        ? t('fill.yes')
        : value === 'no'
          ? t('fill.no')
          : t('fill.notApplicable');
    case 'rating':
      return t('fill.rating', { value: Number(value), scale: field.scale });
    case 'signature': {
      const parsed = mediaReferenceSchema.safeParse(value);
      return parsed.success && media !== undefined ? (
        <MediaImage
          media={media}
          reference={parsed.data}
          alt={t('fill.signature.image', { question: label })}
          className="h-20 rounded-md border border-border-subtle bg-white"
        />
      ) : null;
    }
    case 'photo':
    case 'file': {
      const references = (value as unknown[]).flatMap((item) => {
        const parsed = mediaReferenceSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
      return (
        <ul className="flex flex-wrap gap-2">
          {references.map((reference, index) => (
            <li key={`${reference.mediaId}-${String(index)}`}>
              {media === undefined ? null : field.type === 'photo' ? (
                <MediaImage
                  media={media}
                  reference={reference}
                  alt={`${label}: ${t('fill.files.photo', { number: index + 1 })}`}
                  className="size-20 rounded-md border border-border-subtle object-cover"
                />
              ) : (
                <FileLink
                  media={media}
                  reference={reference}
                  name={t('fill.files.file', { number: index + 1 })}
                  locale={locale}
                />
              )}
            </li>
          ))}
        </ul>
      );
    }
    case 'gps': {
      const parsed = geoPointSchema.safeParse(value);
      if (!parsed.success) {
        return null;
      }
      return (
        <>
          {t('fill.gps.value', {
            latitude: parsed.data.latitude,
            longitude: parsed.data.longitude,
          })}
          {parsed.data.accuracyMeters === undefined
            ? ''
            : ` ${t('fill.gps.within', { meters: parsed.data.accuracyMeters })}`}
        </>
      );
    }
  }
}

function FileLink({
  media,
  reference,
  name,
  locale,
}: {
  media: MediaAdapter;
  reference: { mediaId: string; contentType: string; byteSize: number };
  name: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const url = useMediaUrl(media, reference);
  const details = t('fill.files.details', {
    type: reference.contentType,
    size: formatBytes(reference.byteSize, locale),
  });
  return url === undefined ? (
    <span>
      {name} ({details})
    </span>
  ) : (
    <a href={url} target="_blank" rel="noreferrer noopener" className="text-accent underline">
      {t('fill.files.open', { name })} ({details})
    </a>
  );
}
