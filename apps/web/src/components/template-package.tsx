'use client';

import { ApiRequestError, type paths } from '@integr8/api-client';
import { formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { pickMessage } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * The template library and `.integr8form` files on the dashboard (form
 * builder decision 14, 1.3.0): import a file as a new staff-made library
 * template — how a catalogue moves from one Integr8 Plus server to another —
 * and export any template as a file. The format is `@integr8/form-package` on
 * the server; the dashboard only sends and saves bytes.
 */

export const PACKAGE_EXTENSION = '.integr8form';
export const PACKAGE_MEDIA_TYPE = 'application/vnd.integr8.form+zip';
/** The server's cap; a larger file is refused here rather than after uploading it. */
export const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;

const CATEGORIES = ['maintenance', 'safety', 'completion'] as const;
type Category = (typeof CATEGORIES)[number];

export type ImportedTemplate =
  paths['/v1/platform/form-templates/import']['post']['responses'][201]['content']['application/json'];

/** The file's name, as the server names it. */
export function packageFilename(title: string): string {
  const name = Array.from(title)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && !'<>:"/\\|?*'.includes(char);
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .slice(0, 100)
    .trim();
  return `${name === '' ? 'form' : name}${PACKAGE_EXTENSION}`;
}

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** "Export" on a template's row. */
export function ExportTemplateButton({
  templateKey,
  title,
}: {
  templateKey: string;
  title: string;
}) {
  const { t } = useTranslation();
  const run = useMutation({
    mutationFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/form-templates/{key}/export', {
        params: { path: { key: templateKey } },
        parseAs: 'blob',
      });
      saveFile(data!, packageFilename(title));
    },
  });
  return (
    <>
      <Button
        variant="secondary"
        busy={run.isPending}
        title={t('platform.templatePackages.exportHelp')}
        onClick={() => run.mutate()}
      >
        {t('platform.templatePackages.export')}
      </Button>
      {run.isError ? (
        <span role="alert" className="text-xs text-danger">
          {messageForError(run.error, t)}
        </span>
      ) : null}
    </>
  );
}

/** "Import a form file" above the list. */
export function ImportTemplatePanel({ queryKey }: { queryKey: readonly unknown[] }) {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();
  const inputId = useId();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [category, setCategory] = useState<Category>('maintenance');
  const tooLarge = file !== undefined && file.size > PACKAGE_MAX_BYTES;
  const wrongKind = file !== undefined && !file.name.toLowerCase().endsWith(PACKAGE_EXTENSION);

  const run = useMutation({
    mutationFn: async (chosen: File) =>
      (
        await platformClient().POST('/v1/platform/form-templates/import', {
          params: { query: { category } },
          // The file itself is the body: no JSON around it.
          body: chosen as unknown as string,
          bodySerializer: (body: unknown) => body as Blob,
          headers: { 'content-type': PACKAGE_MEDIA_TYPE },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (file !== undefined && !tooLarge && !wrongKind) {
      run.mutate(file);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border-subtle p-4 text-sm">
      <h2 className="text-base font-semibold text-content">
        {t('platform.templatePackages.importTitle')}
      </h2>
      <p className="text-content-muted">{t('platform.templatePackages.importBody')}</p>
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
        <label htmlFor={inputId} className="flex flex-col gap-1">
          <span className="font-medium text-content">{t('platform.templatePackages.file')}</span>
          <input
            id={inputId}
            type="file"
            accept={`${PACKAGE_EXTENSION},${PACKAGE_MEDIA_TYPE}`}
            disabled={run.isPending}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              run.reset();
              setFile(event.target.files?.[0]);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium text-content">
            {t('platform.libraryTemplates.category')}
          </span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as Category)}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
          >
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {t(`forms.templates.category.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          busy={run.isPending}
          disabled={file === undefined || tooLarge || wrongKind}
        >
          {t('platform.templatePackages.importSubmit')}
        </Button>
      </form>
      {file === undefined ? null : (
        <p className="text-xs text-content-muted">
          <span dir="auto" className="font-mono">
            {file.name}
          </span>{' '}
          ·{' '}
          {t('platform.templatePackages.size', {
            size: formatNumber(Math.max(0.1, file.size / 1024 / 1024), {
              locale: i18n.language,
              maximumFractionDigits: 1,
            }),
          })}
        </p>
      )}
      {wrongKind ? (
        <p role="alert" className="text-danger">
          {t('platform.templatePackages.notAPackage')}
        </p>
      ) : null}
      {tooLarge ? (
        <p role="alert" className="text-danger">
          {t('apiErrors.package_too_large')}
        </p>
      ) : null}
      {run.isPending ? (
        <p role="status" className="text-content-muted">
          {t('platform.templatePackages.importing')}
        </p>
      ) : null}
      {run.isError ? <TemplateImportRefusal error={run.error} /> : null}
      {run.isSuccess ? <TemplateImportResult result={run.data} /> : null}
    </section>
  );
}

/** A refused file: the sentence for its code, and each problem with where it is. */
export function TemplateImportRefusal({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const details = error instanceof ApiRequestError ? error.details : [];
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-subtle p-3">
      <p>{messageForError(error, t)}</p>
      {details.length === 0 ? null : (
        <>
          <p className="font-medium">{t('platform.templatePackages.problems')}</p>
          <ul className="flex flex-col gap-1 text-xs">
            {details.map((detail, index) => (
              <li key={`${detail.field}-${String(index)}`} className="flex flex-col">
                <span dir="ltr" className="text-start">
                  {detail.message}
                </span>
                <span dir="ltr" className="text-start font-mono text-content-muted">
                  {detail.field}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** What the import made, and what is worth a look. */
export function TemplateImportResult({ result }: { result: ImportedTemplate }) {
  const { t, i18n } = useTranslation();
  const number = (value: number) => formatNumber(value, { locale: i18n.language });
  const untranslated = result.check.warnings.filter(
    (warning) => warning.code === 'translation_missing',
  ).length;
  const others = result.check.warnings.filter((warning) => warning.code !== 'translation_missing');
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md bg-success-subtle p-3">
      <p>
        {t('platform.templatePackages.created', {
          name: pickMessage(result.template.title, i18n.language),
          key: result.template.key,
        })}
      </p>
      <p className="text-xs text-content-muted">
        {t('platform.templatePackages.counts', {
          templates: number(result.documentTemplatesCreated),
          pictures: number(result.imagesCopied),
        })}{' '}
        <span dir="ltr">
          ({result.source.app} {result.source.version})
        </span>
      </p>
      <p className="text-xs text-content-muted">{t('platform.templatePackages.editAfter')}</p>
      {untranslated === 0 ? null : (
        <p className="text-xs">
          {t('platform.templatePackages.untranslated', { number: number(untranslated) })}
        </p>
      )}
      {others.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-xs">
          {others.map((warning, index) => (
            <li key={`${warning.code}-${String(index)}`} dir="ltr" className="text-start">
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
