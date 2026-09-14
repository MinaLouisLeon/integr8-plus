import { mediaReferenceSchema, type MediaReference } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useId, useState } from 'react';
import { formatBytes } from '../text.js';
import { MediaImage, useMediaUrl } from './media-image.js';
import type { MediaAdapter } from '../media.js';
import { buttonClass, type WidgetProps } from './types.js';

/**
 * Photos and files.
 *
 * The native file input, which is a labelled, keyboard-operable control on
 * every platform, and on a phone offers the camera for `capture`. Each chosen
 * file is checked against the question's limits before it is sent, so a person
 * learns a photo is too large without waiting for the upload — the server
 * checks again when the form is submitted.
 */

interface Uploading {
  key: string;
  name: string;
  progress: number;
  failed: boolean;
}

function accepts(accepted: readonly string[] | undefined, type: string): boolean {
  if (accepted === undefined) {
    return true;
  }
  return accepted.some((pattern) =>
    pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type,
  );
}

export function FilesWidget(props: WidgetProps<'photo' | 'file'>) {
  const {
    field,
    value,
    id,
    label,
    describedBy,
    disabled,
    invalid,
    locale,
    media,
    onAnswer,
    onBlur,
  } = props;
  const { t } = useTranslation();
  const inputId = useId();
  const references = Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = mediaReferenceSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const photos = field.type === 'photo';
  const accepted = photos ? ['image/*'] : field.acceptedTypes;
  const room =
    field.maxFiles === undefined ? Number.POSITIVE_INFINITY : field.maxFiles - references.length;

  const choose = async (files: FileList | null) => {
    if (files === null || media === undefined) {
      return;
    }
    const found: string[] = [];
    const chosen = [...files];
    if (chosen.length > room) {
      found.push(t('fill.files.tooMany', { maximum: field.maxFiles ?? 0 }));
    }
    const sending = chosen.slice(0, Math.max(0, room)).filter((file) => {
      if (!accepts(accepted, file.type)) {
        found.push(t('fill.files.wrongType', { name: file.name }));
        return false;
      }
      if (field.maxFileBytes !== undefined && file.size > field.maxFileBytes) {
        found.push(
          t('fill.files.tooLarge', {
            name: file.name,
            maximum: formatBytes(field.maxFileBytes, locale),
          }),
        );
        return false;
      }
      return true;
    });
    setProblems(found);

    let collected = [...references];
    await Promise.all(
      sending.map(async (file, index) => {
        const key = `${file.name}-${String(Date.now())}-${String(index)}`;
        setUploads((current) => [...current, { key, name: file.name, progress: 0, failed: false }]);
        try {
          const reference = await media.upload(file, {
            contentType: file.type,
            onProgress: (fraction) =>
              setUploads((current) =>
                current.map((upload) =>
                  upload.key === key ? { ...upload, progress: fraction } : upload,
                ),
              ),
          });
          collected = [...collected, reference];
          onAnswer(collected);
          setUploads((current) => current.filter((upload) => upload.key !== key));
        } catch {
          setUploads((current) =>
            current.map((upload) => (upload.key === key ? { ...upload, failed: true } : upload)),
          );
        }
      }),
    );
    onBlur();
  };

  return (
    <div className="flex flex-col gap-3" id={id} tabIndex={-1} aria-describedby={describedBy}>
      {references.length === 0 ? null : (
        <ul className="flex flex-wrap gap-3">
          {references.map((reference, index) => {
            const name = photos
              ? t('fill.files.photo', { number: index + 1 })
              : t('fill.files.file', { number: index + 1 });
            return (
              <li
                key={`${reference.mediaId}-${String(index)}`}
                className="flex flex-col items-start gap-1"
              >
                {media === undefined ? null : (
                  <Stored
                    media={media}
                    reference={reference}
                    name={name}
                    question={label}
                    photo={photos}
                    locale={locale}
                  />
                )}
                {disabled ? null : (
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() => {
                      const rest = references.filter((_, at) => at !== index);
                      onAnswer(rest.length === 0 ? [] : rest);
                      onBlur();
                    }}
                  >
                    {t('fill.files.remove', { name })}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {uploads.length === 0 ? null : (
        <ul className="flex flex-col gap-1" aria-live="polite">
          {uploads.map((upload) => (
            <li
              key={upload.key}
              className={`text-xs ${upload.failed ? 'text-danger' : 'text-content-muted'}`}
            >
              {upload.failed
                ? t('fill.files.failed', { name: upload.name })
                : t('fill.files.uploading', {
                    name: upload.name,
                    percent: Math.round(upload.progress * 100),
                  })}
            </li>
          ))}
        </ul>
      )}

      {disabled || room <= 0 || media === undefined ? null : (
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className={`${buttonClass.secondary} w-fit cursor-pointer`}>
            {photos ? t('fill.files.addPhotos') : t('fill.files.addFiles')}
          </label>
          <input
            id={inputId}
            type="file"
            className="sr-only"
            multiple={field.maxFiles !== 1}
            accept={accepted?.join(',')}
            {...(photos ? { capture: 'environment' as const } : {})}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => {
              void choose(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
      )}

      {problems.length === 0 ? null : (
        <ul role="alert" className="flex flex-col gap-0.5">
          {problems.map((problem) => (
            <li key={problem} className="text-xs text-danger">
              {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stored({
  media,
  reference,
  name,
  question,
  photo,
  locale,
}: {
  media: MediaAdapter;
  reference: MediaReference;
  name: string;
  question: string;
  photo: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const url = useMediaUrl(media, reference);
  if (photo) {
    return (
      <MediaImage
        media={media}
        reference={reference}
        alt={`${question}: ${name}`}
        className="size-24 rounded-md border border-border-subtle object-cover"
      />
    );
  }
  const details = t('fill.files.details', {
    type: reference.contentType,
    size: formatBytes(reference.byteSize, locale),
  });
  return url === undefined ? (
    <span className="text-sm text-content">
      {name} <span className="text-content-muted">({details})</span>
    </span>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-sm text-accent underline"
    >
      {t('fill.files.open', { name })} <span className="text-content-muted">({details})</span>
    </a>
  );
}
