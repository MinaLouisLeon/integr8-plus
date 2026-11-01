import { ApiRequestError, type paths } from '@integr8/api-client';
import {
  apiErrorCodeMessage,
  apiErrorMessage,
  formatNumber,
  type TFunction,
  useTranslation,
} from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, ErrorState } from '~/components/ui';
import { session } from '~/lib/session';
import { formKeys, useMe } from '../api';
import { Dialog } from './dialog';

/**
 * A form and its PDF templates in one `.integr8form` file (form builder
 * decision 14, 1.3.0), for Integr8 staff in a company's seat: "Export form"
 * in the form builder, "Import form" on the forms list. The format itself is
 * `@integr8/form-package` on the server; this app only sends and saves bytes,
 * so the few facts it needs about the file are repeated here.
 *
 * Shown only to a staff session — the routes refuse anybody else anyway.
 */

export const PACKAGE_EXTENSION = '.integr8form';
export const PACKAGE_MEDIA_TYPE = 'application/vnd.integr8.form+zip';
/** The server's cap; a larger file is refused here rather than after uploading it. */
export const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;

export type ImportedForm =
  paths['/v1/forms/import']['post']['responses'][201]['content']['application/json'];
type PackageProblem = ImportedForm['check']['problems'][number];

const client = () => session().client;

/** The file's name, as the server names it: the title without what a file name cannot hold. */
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

/**
 * A download, the way the app's other exports save files: handed to the
 * webview, which saves to the downloads folder.
 */
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

/** Whether this is a staff session: the only one these actions are for. */
function useIsStaff(): boolean {
  return useMe().data?.impersonatedBy != null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function ExportFormAction({
  formId,
  formTitle,
  publishedVersion,
  hasDraft,
}: {
  formId: string;
  formTitle: string;
  /** The published version's number, or null when the form was never published. */
  publishedVersion: number | null;
  hasDraft: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  if (!useIsStaff()) {
    return null;
  }
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t('forms.packageFile.export')}
      </Button>
      {notice === undefined ? null : (
        <span role="status" className="rounded-full bg-success-subtle px-3 py-1 text-xs">
          {notice}
          <button
            type="button"
            className="ms-2 text-content-muted hover:text-content"
            aria-label={t('common.close')}
            onClick={() => setNotice(undefined)}
          >
            ✕
          </button>
        </span>
      )}
      <ExportFormDialog
        open={open}
        formId={formId}
        formTitle={formTitle}
        publishedVersion={publishedVersion}
        hasDraft={hasDraft}
        onClose={() => setOpen(false)}
        onDone={(file) => {
          setOpen(false);
          setNotice(t('forms.packageFile.exported', { file }));
        }}
      />
    </>
  );
}

export function ExportFormDialog({
  open,
  formId,
  formTitle,
  publishedVersion,
  hasDraft,
  onClose,
  onDone,
  save = saveFile,
}: {
  open: boolean;
  formId: string;
  formTitle: string;
  publishedVersion: number | null;
  hasDraft: boolean;
  onClose: () => void;
  onDone: (filename: string) => void;
  /** Where the file goes; the browser download unless a test says otherwise. */
  save?: (blob: Blob, filename: string) => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<'published' | 'draft' | undefined>(undefined);
  const source = chosen ?? (publishedVersion === null ? 'draft' : 'published');
  const both = publishedVersion !== null && hasDraft;
  const filename = packageFilename(formTitle);

  const run = useMutation({
    mutationFn: async () => {
      const { data } = await client().GET('/v1/forms/{formId}/export', {
        params: { path: { formId }, query: { source } },
        parseAs: 'blob',
      });
      save(data!, filename);
      return filename;
    },
    onSuccess: (file) => onDone(file),
  });

  return (
    <Dialog
      open={open}
      title={t('forms.packageFile.exportTitle', { name: formTitle })}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          run.mutate();
        }}
      >
        <p className="text-content-muted">{t('forms.packageFile.exportBody')}</p>
        {both ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-content">
              {t('forms.packageFile.sourceLabel')}
            </legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="source"
                className="mt-1"
                checked={source === 'published'}
                onChange={() => setChosen('published')}
              />
              <span>
                {t('forms.packageFile.sourcePublished', { version: String(publishedVersion) })}
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="source"
                className="mt-1"
                checked={source === 'draft'}
                onChange={() => setChosen('draft')}
              />
              <span>{t('forms.packageFile.sourceDraft')}</span>
            </label>
          </fieldset>
        ) : (
          <p>
            {source === 'published'
              ? t('forms.packageFile.onlyPublished', { version: String(publishedVersion) })
              : t('forms.packageFile.onlyDraft')}
          </p>
        )}
        <p className="text-xs text-content-muted">{t('forms.packageFile.neverIncluded')}</p>
        <p className="text-xs text-content-muted">
          {t('forms.packageFile.fileName')}{' '}
          <span dir="auto" className="font-mono">
            {filename}
          </span>
        </p>
        {run.isError ? <ErrorState message={apiErrorMessage(run.error, t)} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={run.isPending}>
            {t('forms.packageFile.exportSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function ImportFormAction() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!useIsStaff()) {
    return null;
  }
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('forms.packageFile.import')}
      </Button>
      <ImportFormDialog
        open={open}
        onClose={() => setOpen(false)}
        onOpenDraft={(formId) => {
          setOpen(false);
          void navigate(`/forms/${formId}`);
        }}
      />
    </>
  );
}

/** Why a chosen file is not sent at all, or undefined when it may be. */
export function fileRefusal(
  file: { name: string; size: number },
  t: TFunction,
): string | undefined {
  if (!file.name.toLowerCase().endsWith(PACKAGE_EXTENSION)) {
    return t('forms.packageFile.notAPackage');
  }
  if (file.size > PACKAGE_MAX_BYTES) {
    return apiErrorCodeMessage('package_too_large', t) ?? t('forms.packageFile.notAPackage');
  }
  return undefined;
}

export function ImportFormDialog({
  open,
  onClose,
  onOpenDraft,
}: {
  open: boolean;
  onClose: () => void;
  onOpenDraft: (formId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();
  const inputId = useId();
  const [file, setFile] = useState<File | undefined>(undefined);
  const refusal = file === undefined ? undefined : fileRefusal(file, t);

  const run = useMutation({
    mutationFn: async (chosen: File) =>
      (
        await client().POST('/v1/forms/import', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          // The file itself is the body: no JSON around it.
          body: chosen as unknown as string,
          bodySerializer: (body: unknown) => body as Blob,
          headers: { 'content-type': PACKAGE_MEDIA_TYPE },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey: formKeys.list }),
  });

  const close = () => {
    setFile(undefined);
    run.reset();
    onClose();
  };

  const title = run.isSuccess
    ? t('forms.packageFile.resultTitle')
    : t('forms.packageFile.importTitle');

  return (
    <Dialog open={open} wide title={title} onClose={close}>
      {run.isSuccess ? (
        <ImportResult result={run.data} onOpenDraft={onOpenDraft} onClose={close} />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (file !== undefined && refusal === undefined) {
              run.mutate(file);
            }
          }}
        >
          <p className="text-content-muted">{t('forms.packageFile.importBody')}</p>
          <label htmlFor={inputId} className="flex flex-col gap-1">
            <span className="text-sm font-medium text-content">
              {t('forms.packageFile.chooseFile')}
            </span>
            <input
              id={inputId}
              type="file"
              accept={`${PACKAGE_EXTENSION},${PACKAGE_MEDIA_TYPE}`}
              disabled={run.isPending}
              className="text-sm"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                run.reset();
                setFile(event.target.files?.[0]);
              }}
            />
          </label>
          {file === undefined ? null : (
            <p className="text-xs text-content-muted">
              <span dir="auto" className="font-mono">
                {file.name}
              </span>{' '}
              ·{' '}
              {t('forms.packageFile.size', {
                size: formatNumber(Math.max(0.1, file.size / 1024 / 1024), {
                  locale: i18n.language,
                  maximumFractionDigits: 1,
                }),
              })}
            </p>
          )}
          {refusal === undefined ? null : (
            <p role="alert" className="rounded-md bg-danger-subtle p-3">
              {refusal}
            </p>
          )}
          {run.isPending ? (
            <p role="status" className="rounded-md bg-surface-muted p-3">
              {t('forms.packageFile.importing')}
            </p>
          ) : null}
          {run.isError ? <ImportRefusal error={run.error} /> : null}
          <p className="text-xs text-content-muted">{t('forms.packageFile.neverIncluded')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              busy={run.isPending}
              disabled={file === undefined || refusal !== undefined}
            >
              {t('forms.packageFile.importSubmit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** A file the server refused: its sentence, and where in the file each problem is. */
function ImportRefusal({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const details = error instanceof ApiRequestError ? error.details : [];
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-subtle p-3">
      <p>{apiErrorMessage(error, t)}</p>
      {details.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-xs">
          {details.map((detail, index) => (
            <li key={`${detail.field}-${String(index)}`} dir="ltr" className="text-start">
              <span className="font-mono">{detail.field}</span>: {detail.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Words for a problem or warning the check reported, where this app has its own. */
export function issueWords(issue: PackageProblem, t: TFunction): string {
  switch (issue.code) {
    case 'title_mismatch':
      return t('forms.packageFile.issue.titleMismatch');
    case 'templates_not_checked':
      return t('forms.packageFile.issue.templatesNotChecked');
    case 'file_missing':
      return t('forms.packageFile.issue.fileMissing');
    case 'file_unused':
      return t('forms.packageFile.issue.fileUnused');
    default:
      return issue.message;
  }
}

/** Where in the file: `templates/1.json · design.blocks.title`. */
const where = (issue: PackageProblem) =>
  issue.path === '' ? issue.entry : `${issue.entry} · ${issue.path}`;

function IssueList({ issues, total }: { issues: readonly PackageProblem[]; total: number }) {
  const { t, i18n } = useTranslation();
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map((issue, index) => (
        <li
          key={`${issue.entry}-${issue.path}-${issue.code}-${String(index)}`}
          className="flex flex-col"
        >
          <span dir="auto">{issueWords(issue, t)}</span>
          <span dir="ltr" className="text-start font-mono text-xs text-content-muted">
            {where(issue)}
          </span>
        </li>
      ))}
      {total > issues.length ? (
        <li className="text-xs text-content-muted">
          {t('forms.packageFile.notShown', {
            number: formatNumber(total - issues.length, { locale: i18n.language }),
          })}
        </li>
      ) : null}
    </ul>
  );
}

export function ImportResult({
  result,
  onOpenDraft,
  onClose,
}: {
  result: ImportedForm;
  onOpenDraft: (formId: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const number = (value: number) => formatNumber(value, { locale: i18n.language });
  const translations = result.check.warnings.filter(
    (issue) => issue.code === 'translation_missing',
  );
  const otherWarnings = result.check.warnings.filter(
    (issue) => issue.code !== 'translation_missing',
  );
  const untranslated =
    translations.length === result.check.warnings.length
      ? result.check.warningCount
      : translations.length;

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="rounded-md bg-success-subtle p-3">
        {t('forms.packageFile.created', { title: result.title })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-content-muted">{t('forms.packageFile.pdfTemplates')}</dt>
        <dd>{number(result.documentTemplatesCreated)}</dd>
        <dt className="text-content-muted">{t('forms.packageFile.pictures')}</dt>
        <dd>{number(result.imagesCopied)}</dd>
        <dt className="text-content-muted">{t('forms.packageFile.madeBy')}</dt>
        <dd>
          <span dir="ltr">
            {result.source.app} {result.source.version}
          </span>
          {' · '}
          {result.source.exportedFrom === 'published'
            ? t('forms.packageFile.fromPublished', {
                version: String(result.source.versionNumber ?? '—'),
              })
            : t('forms.packageFile.fromDraft')}
        </dd>
      </dl>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-content">{t('forms.packageFile.problemsTitle')}</h3>
        {result.check.problemCount === 0 ? (
          <p className="text-content-muted">{t('forms.packageFile.problemsNone')}</p>
        ) : (
          <div className="flex flex-col gap-2 rounded-md bg-danger-subtle p-3">
            <p>{t('forms.packageFile.problemsBody')}</p>
            <IssueList issues={result.check.problems} total={result.check.problemCount} />
          </div>
        )}
      </section>

      {result.check.warningCount === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold text-content">{t('forms.packageFile.warningsTitle')}</h3>
          <div className="flex flex-col gap-2 rounded-md bg-warning-subtle p-3">
            {untranslated === 0 ? null : (
              <p>{t('forms.packageFile.untranslated', { number: number(untranslated) })}</p>
            )}
            {otherWarnings.length === 0 ? null : (
              <IssueList issues={otherWarnings} total={otherWarnings.length} />
            )}
          </div>
        </section>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
        <Button onClick={() => onOpenDraft(result.formId)}>
          {t('forms.packageFile.openDraft')}
        </Button>
      </div>
    </div>
  );
}
