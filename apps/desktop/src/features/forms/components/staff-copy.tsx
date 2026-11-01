import { apiErrorMessage, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { session } from '~/lib/session';
import { formKeys, useMe } from '../api';
import { Dialog } from './dialog';

/**
 * Copying a form out of this company (form builder decision 1, 1.3.0), for
 * Integr8 staff in the company's seat: to another company as an unpublished
 * draft (1A), or into the template library every company starts from (1B).
 *
 * Shown only to a staff session — the routes refuse anybody else anyway.
 */

const client = () => session().client;

const CATEGORIES = ['maintenance', 'safety', 'completion'] as const;
type Category = (typeof CATEGORIES)[number];

export function StaffCopyActions({
  formId,
  formTitle,
  published,
}: {
  formId: string;
  formTitle: string;
  /** Whether the form has a published version: the library takes only that. */
  published: boolean;
}) {
  const { t } = useTranslation();
  const me = useMe();
  const [open, setOpen] = useState<'company' | 'library' | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  if (me.data?.impersonatedBy == null) {
    return null;
  }
  const canDesign = me.data.permissions.includes('document.design');

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen('company')}>
        {t('forms.staffCopy.toCompany')}
      </Button>
      <Button variant="ghost" onClick={() => setOpen('library')}>
        {t('forms.staffCopy.toLibrary')}
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
      <CopyToCompanyDialog
        open={open === 'company'}
        formId={formId}
        formTitle={formTitle}
        canDesign={canDesign}
        onClose={() => setOpen(null)}
        onDone={(message) => {
          setOpen(null);
          setNotice(message);
        }}
      />
      <SaveToLibraryDialog
        open={open === 'library'}
        formId={formId}
        formTitle={formTitle}
        published={published}
        canDesign={canDesign}
        onClose={() => setOpen(null)}
        onDone={(message) => {
          setOpen(null);
          setNotice(message);
        }}
      />
    </>
  );
}

export function CopyToCompanyDialog({
  open,
  formId,
  formTitle,
  canDesign,
  onClose,
  onDone,
}: {
  open: boolean;
  formId: string;
  formTitle: string;
  canDesign: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [withTemplates, setWithTemplates] = useState(canDesign);
  const [reason, setReason] = useState('');
  const name = title ?? formTitle;

  const companies = useQuery({
    queryKey: ['forms', 'copy-targets', search.trim()],
    enabled: open,
    queryFn: async () =>
      (
        await client().GET('/v1/forms/copy-targets', {
          params: { query: search.trim() === '' ? {} : { search: search.trim() } },
        })
      ).data!.items,
  });
  const copy = useMutation({
    mutationFn: async (tenantId: string) =>
      (
        await client().POST('/v1/forms/{formId}/copy-to-company', {
          params: { path: { formId }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            tenantId,
            title: name.trim(),
            includeDocumentTemplates: canDesign && withTemplates,
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          },
        })
      ).data!,
    onSuccess: (copied) => {
      onDone(
        copied.documentTemplatesCopied > 0
          ? t('forms.staffCopy.companyDoneWithPdfs', {
              company: copied.companyName,
              templates: String(copied.documentTemplatesCopied),
            })
          : t('forms.staffCopy.companyDone', { company: copied.companyName }),
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen !== null && name.trim() !== '') {
      copy.mutate(chosen);
    }
  };

  return (
    <Dialog
      open={open}
      wide
      title={t('forms.staffCopy.companyTitle', { name: formTitle })}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-content-muted">{t('forms.staffCopy.companyBody')}</p>
        <Field
          label={t('forms.staffCopy.search')}
          value={search}
          maxLength={100}
          onChange={(event) => setSearch(event.target.value)}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-content">
            {t('forms.staffCopy.company')}
          </legend>
          {companies.isPending ? <LoadingState /> : null}
          {companies.data?.length === 0 ? (
            <p className="text-content-muted">{t('forms.staffCopy.noCompanies')}</p>
          ) : null}
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border-subtle p-1">
            {(companies.data ?? []).map((company) => (
              <li key={company.id}>
                <label
                  className={[
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5',
                    chosen === company.id ? 'bg-accent-subtle' : 'hover:bg-surface-muted',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="company"
                    checked={chosen === company.id}
                    onChange={() => setChosen(company.id)}
                  />
                  <span dir="auto" className="font-medium">
                    {company.name}
                  </span>
                  <span dir="ltr" className="text-xs text-content-muted">
                    {company.slug}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Field
          label={t('forms.staffCopy.name')}
          value={name}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        {canDesign ? (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={withTemplates}
              onChange={(event) => setWithTemplates(event.target.checked)}
            />
            <span>
              {t('forms.staffCopy.includePdfs')}
              <span className="block text-xs text-content-muted">
                {t('forms.staffCopy.includePdfsHelp')}
              </span>
            </span>
          </label>
        ) : null}
        <Field
          label={t('forms.staffCopy.reason')}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="text-xs text-content-muted">{t('forms.staffCopy.neverCopied')}</p>
        {copy.isError ? <ErrorState message={apiErrorMessage(copy.error, t)} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            busy={copy.isPending}
            disabled={chosen === null || name.trim() === ''}
          >
            {t('forms.staffCopy.companySubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A key from a title: lowercase letters, digits and underscores, starting with a letter. */
export function suggestKey(title: string): string {
  const key = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .replace(/^[^a-z]+/u, '')
    .slice(0, 64);
  return key === '' ? 'form_template' : key;
}

export function SaveToLibraryDialog({
  open,
  formId,
  formTitle,
  published,
  canDesign,
  onClose,
  onDone,
}: {
  open: boolean;
  formId: string;
  formTitle: string;
  published: boolean;
  canDesign: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [key, setKey] = useState<string | undefined>(undefined);
  const [nameEn, setNameEn] = useState<string | undefined>(undefined);
  const [nameAr, setNameAr] = useState('');
  const [descriptionEn, setDescriptionEn] = useState('');
  const [descriptionAr, setDescriptionAr] = useState('');
  const [category, setCategory] = useState<Category>('maintenance');
  const [withTemplates, setWithTemplates] = useState(canDesign);
  const english = nameEn ?? formTitle;
  const chosenKey = key ?? suggestKey(english);
  const keyValid = /^[a-z][a-z0-9_]{0,63}$/u.test(chosenKey);

  const save = useMutation({
    mutationFn: async () =>
      (
        await client().POST('/v1/forms/{formId}/library-template', {
          params: { path: { formId }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            key: chosenKey,
            title: { en: english.trim(), ar: nameAr.trim() },
            description: { en: descriptionEn.trim(), ar: descriptionAr.trim() },
            category,
            includeDocumentTemplates: canDesign && withTemplates,
          },
        })
      ).data!,
    onSuccess: (saved) => {
      void queries.invalidateQueries({ queryKey: formKeys.templates });
      onDone(t('forms.staffCopy.libraryDone', { key: saved.key }));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (published && keyValid && (english.trim() !== '' || nameAr.trim() !== '')) {
      save.mutate();
    }
  };

  return (
    <Dialog
      open={open}
      wide
      title={t('forms.staffCopy.libraryTitle', { name: formTitle })}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-content-muted">{t('forms.staffCopy.libraryBody')}</p>
        {published ? null : (
          <p role="alert" className="rounded-md bg-warning-subtle p-3">
            {t('forms.staffCopy.libraryNotPublished')}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('forms.staffCopy.nameEn')}
            value={english}
            dir="ltr"
            maxLength={200}
            onChange={(event) => setNameEn(event.target.value)}
          />
          <Field
            label={t('forms.staffCopy.nameAr')}
            value={nameAr}
            dir="rtl"
            lang="ar"
            maxLength={200}
            onChange={(event) => setNameAr(event.target.value)}
          />
          <Field
            label={t('forms.staffCopy.descriptionEn')}
            value={descriptionEn}
            dir="ltr"
            maxLength={2000}
            onChange={(event) => setDescriptionEn(event.target.value)}
          />
          <Field
            label={t('forms.staffCopy.descriptionAr')}
            value={descriptionAr}
            dir="rtl"
            lang="ar"
            maxLength={2000}
            onChange={(event) => setDescriptionAr(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('forms.staffCopy.key')}
            value={chosenKey}
            dir="ltr"
            maxLength={64}
            onChange={(event) => setKey(event.target.value)}
            error={keyValid ? undefined : t('forms.staffCopy.keyInvalid')}
          />
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-content">
              {t('forms.staffCopy.category')}
            </span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {t(`forms.templates.category.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {canDesign ? (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={withTemplates}
              onChange={(event) => setWithTemplates(event.target.checked)}
            />
            <span>
              {t('forms.staffCopy.libraryPdfs')}
              <span className="block text-xs text-content-muted">
                {t('forms.staffCopy.libraryPdfsHelp')}
              </span>
            </span>
          </label>
        ) : null}
        {save.isError ? <ErrorState message={apiErrorMessage(save.error, t)} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            busy={save.isPending}
            disabled={!published || !keyValid || (english.trim() === '' && nameAr.trim() === '')}
          >
            {t('forms.staffCopy.librarySubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
