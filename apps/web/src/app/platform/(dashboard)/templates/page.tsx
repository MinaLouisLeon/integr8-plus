'use client';

import { ApiRequestError, type paths } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge } from '~/components/platform-bits';
import { ExportTemplateButton, ImportTemplatePanel } from '~/components/template-package';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatWhen, pickMessage } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * The global form template library (P15; form builder decision 1B, 1.3.0).
 *
 * Two kinds of template live here. The built-in ones ship with the product and
 * are read-only on this screen: `db templates` keeps them equal to the code.
 * Staff-made ones were saved from a company's form in the staff desktop app
 * ("Save as library template"), with that form's PDF templates; here they are
 * renamed, replaced with the newer version of the form they came from, and
 * retired or brought back. A retired template leaves the companies' picker;
 * forms already made from it are copies and do not change.
 *
 * There is still no definition editor here on purpose: a template is a form,
 * and editing a form is what the form builder is for. A `.integr8form` file
 * (decision 14) is imported here as a new staff-made template, and any
 * template exported as one, to move a catalogue between servers.
 */

type Template =
  paths['/v1/platform/form-templates']['get']['responses'][200]['content']['application/json']['items'][number];

const CATEGORIES = ['maintenance', 'safety', 'completion'] as const;
const QUERY_KEY = ['platform', 'templates'] as const;

export default function TemplatesPage() {
  const { t } = useTranslation();
  const [showRetired, setShowRetired] = useState(false);

  const templates = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<Template[]> => {
      const { data } = await platformClient().GET('/v1/platform/form-templates');
      return data?.items ?? [];
    },
  });

  const shown = (templates.data ?? []).filter(
    (template) => showRetired || template.retiredAt === null,
  );

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.templates.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.templates.subtitle')}</p>
        <p className="text-sm text-content-muted">{t('platform.libraryTemplates.howToAdd')}</p>
      </header>

      <ImportTemplatePanel queryKey={QUERY_KEY} />

      <label className="flex items-center gap-2 text-sm text-content-muted">
        <input
          type="checkbox"
          checked={showRetired}
          onChange={(event) => setShowRetired(event.target.checked)}
        />
        {t('platform.libraryTemplates.showRetired')}
      </label>

      {templates.isPending ? <LoadingState /> : null}

      {templates.isError ? (
        <ErrorState
          requestId={
            templates.error instanceof ApiRequestError ? templates.error.requestId : undefined
          }
          onRetry={() => void templates.refetch()}
        />
      ) : null}

      {templates.isSuccess && shown.length === 0 ? (
        <EmptyState title={t('platform.templates.empty')} />
      ) : null}

      {templates.isSuccess && shown.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {shown.map((template) => (
            <TemplateRow key={template.key} template={template} />
          ))}
        </ul>
      ) : null}
    </main>
  );
}

function TemplateRow({ template }: { template: Template }) {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const staffMade = template.source === 'staff';
  const exportName = template.title.en ?? Object.values(template.title)[0] ?? template.key;
  const refreshList = () => void queries.invalidateQueries({ queryKey: QUERY_KEY });

  const retire = useMutation({
    mutationFn: async (retired: boolean) => {
      await platformClient().POST('/v1/platform/form-templates/{key}/retire', {
        params: { path: { key: template.key } },
        body: { retired },
      });
    },
    onSuccess: refreshList,
  });
  const refresh = useMutation({
    mutationFn: async () =>
      (
        await platformClient().POST('/v1/platform/form-templates/{key}/refresh', {
          params: { path: { key: template.key } },
          body: { includeDocumentTemplates: true },
        })
      ).data,
    onSuccess: (saved) => {
      setNotice(
        t('platform.libraryTemplates.refreshed', {
          key: template.key,
          version: String(saved?.origin?.versionNumber ?? ''),
        }),
      );
      refreshList();
    },
  });
  const failure = retire.error ?? refresh.error;

  return (
    <li className="flex flex-col gap-2 border-b border-border-subtle pb-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-content" dir="auto">
            {pickMessage(template.title, i18n.language)}
          </span>
          <span className="text-content-muted" dir="auto">
            {pickMessage(template.description, i18n.language)}
          </span>
          <span className="font-mono text-xs text-content-muted" dir="ltr">
            {template.key}
          </span>
          {template.origin === null ? null : (
            <span className="text-xs text-content-muted">
              {template.origin.companyName === null
                ? t('platform.libraryTemplates.sourceGone')
                : t('platform.libraryTemplates.source', {
                    company: template.origin.companyName,
                    version: String(template.origin.versionNumber ?? '—'),
                  })}
            </span>
          )}
          {template.documentTemplateCount > 0 ? (
            <span className="text-xs text-content-muted">
              {t('platform.libraryTemplates.pdfs', {
                templates: String(template.documentTemplateCount),
              })}
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={staffMade ? 'ok' : 'muted'}>
            {staffMade
              ? t('platform.libraryTemplates.staffMade')
              : t('platform.libraryTemplates.builtin')}
          </Badge>
          {template.retiredAt === null ? null : (
            <Badge tone="warning">{t('platform.libraryTemplates.retired')}</Badge>
          )}
          <Badge tone="muted">{t(`forms.templates.category.${template.category}`)}</Badge>
          <span className="text-content-muted">
            {t('platform.templates.updated')} {formatWhen(template.updatedAt)}
          </span>
        </span>
      </div>

      {staffMade ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setEditing((value) => !value)}>
            {t('platform.libraryTemplates.edit')}
          </Button>
          <Button
            variant="secondary"
            busy={refresh.isPending}
            disabled={template.origin === null}
            title={t('platform.libraryTemplates.refreshHelp')}
            onClick={() => refresh.mutate()}
          >
            {t('platform.libraryTemplates.refresh')}
          </Button>
          <Button
            variant={template.retiredAt === null ? 'danger' : 'secondary'}
            busy={retire.isPending}
            title={t('platform.libraryTemplates.retireHelp')}
            onClick={() => retire.mutate(template.retiredAt === null)}
          >
            {template.retiredAt === null
              ? t('platform.libraryTemplates.retire')
              : t('platform.libraryTemplates.restore')}
          </Button>
          <ExportTemplateButton templateKey={template.key} title={exportName} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ExportTemplateButton templateKey={template.key} title={exportName} />
          <p className="text-xs text-content-muted">{t('platform.libraryTemplates.readOnly')}</p>
        </div>
      )}

      {notice === undefined ? null : (
        <p role="status" className="text-xs text-success">
          {notice}
        </p>
      )}
      {failure === null ? null : (
        <p role="alert" className="text-xs text-danger">
          {messageForError(failure, t)}
        </p>
      )}

      {editing ? (
        <RenameForm
          template={template}
          onDone={() => {
            setEditing(false);
            refreshList();
          }}
        />
      ) : null}
    </li>
  );
}

function RenameForm({ template, onDone }: { template: Template; onDone: () => void }) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState(template.title.en ?? '');
  const [nameAr, setNameAr] = useState(template.title.ar ?? '');
  const [descriptionEn, setDescriptionEn] = useState(template.description.en ?? '');
  const [descriptionAr, setDescriptionAr] = useState(template.description.ar ?? '');
  const [category, setCategory] = useState(template.category);

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PATCH('/v1/platform/form-templates/{key}', {
        params: { path: { key: template.key } },
        body: {
          title: { en: nameEn, ar: nameAr },
          description: { en: descriptionEn, ar: descriptionAr },
          category,
        },
      });
    },
    onSuccess: onDone,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 rounded-md border border-border-subtle p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('platform.libraryTemplates.nameEn')}
          value={nameEn}
          dir="ltr"
          maxLength={200}
          onChange={(event) => setNameEn(event.target.value)}
        />
        <Field
          label={t('platform.libraryTemplates.nameAr')}
          value={nameAr}
          dir="rtl"
          lang="ar"
          maxLength={200}
          onChange={(event) => setNameAr(event.target.value)}
        />
        <Field
          label={t('platform.libraryTemplates.descriptionEn')}
          value={descriptionEn}
          dir="ltr"
          maxLength={2000}
          onChange={(event) => setDescriptionEn(event.target.value)}
        />
        <Field
          label={t('platform.libraryTemplates.descriptionAr')}
          value={descriptionAr}
          dir="rtl"
          lang="ar"
          maxLength={2000}
          onChange={(event) => setDescriptionAr(event.target.value)}
        />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-content">{t('platform.libraryTemplates.category')}</span>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as Template['category'])}
          className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
        >
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {t(`forms.templates.category.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {save.isError ? (
        <p role="alert" className="text-xs text-danger">
          {messageForError(save.error, t)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={save.isPending}
          disabled={nameEn.trim() === '' && nameAr.trim() === ''}
        >
          {t('platform.libraryTemplates.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('platform.libraryTemplates.cancel')}
        </Button>
      </div>
    </form>
  );
}
