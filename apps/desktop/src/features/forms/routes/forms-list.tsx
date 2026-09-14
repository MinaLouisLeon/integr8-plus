import { ApiRequestError } from '@integr8/api-client';
import {
  compileDefinition,
  createFormState,
  type FormState,
  transition,
  viewForm,
} from '@integr8/form-engine';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMemo, useState, type FormEvent as SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, EmptyState, ErrorState, Field, LoadingState, Shell } from '~/components/ui';
import {
  canManageForms,
  type FormListItem,
  type Template,
  useCopyForm,
  useCopyTemplate,
  useCreateForm,
  useForms,
  useMe,
  useTemplate,
  useTemplates,
} from '../api';
import { Dialog } from '../components/dialog';
import { FormRenderer } from '../components/form-renderer';
import { say } from '../model/text';

/**
 * Every form in the company, and the template library.
 *
 * People who can build forms see drafts and the templates; everyone else sees
 * the forms that are live, and can open any of them read-only.
 */
export function FormsListRoute() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = i18n.language;
  const me = useMe();
  const manage = canManageForms(me.data);
  const forms = useForms();
  const templates = useTemplates(manage);
  const [creating, setCreating] = useState(false);
  const [copying, setCopying] = useState<FormListItem | undefined>(undefined);
  const [previewing, setPreviewing] = useState<string | undefined>(undefined);
  const copyTemplate = useCopyTemplate();

  if (forms.isPending || me.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  if (forms.isError || me.isError) {
    const error = forms.error ?? me.error;
    return (
      <Shell>
        <ErrorState
          requestId={error instanceof ApiRequestError ? error.requestId : undefined}
          onRetry={() => void forms.refetch()}
        />
      </Shell>
    );
  }

  const startFromTemplate = (key: string) =>
    copyTemplate.mutate(key, {
      onSuccess: (detail) => void navigate(`/forms/${detail.form.id}`),
    });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 text-start">
      <nav className="text-sm">
        <Link to="/dashboard" className="text-content-muted hover:underline">
          {t('forms.nav.home')}
        </Link>
      </nav>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('forms.list.title')}</h1>
          <p className="text-sm text-content-muted">{t('forms.list.subtitle')}</p>
        </div>
        {manage ? (
          <Button onClick={() => setCreating(true)}>{t('forms.list.newForm')}</Button>
        ) : null}
      </header>

      {forms.data.length === 0 ? (
        <EmptyState
          title={t('forms.list.emptyTitle')}
          body={manage ? t('forms.list.emptyBody') : t('forms.list.emptyForFillers')}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-content-muted">
                <th className="px-4 py-3 text-start font-medium">{t('forms.list.name')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('forms.list.status')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('forms.list.updated')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {forms.data.map((form) => (
                <tr key={form.id} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-4 py-3 font-medium text-content">
                    <Link to={`/forms/${form.id}`} className="hover:underline">
                      {form.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-content">
                    <div className="flex flex-wrap gap-2">
                      <span>
                        {form.latestVersionNumber === null
                          ? t('forms.list.notPublished')
                          : t('forms.list.live', { number: form.latestVersionNumber })}
                      </span>
                      {form.hasDraft && form.latestVersionNumber !== null ? (
                        <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-xs">
                          {t('forms.list.unpublishedChanges')}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-content-muted">
                    {formatDateTime(form.updatedAt, { locale })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {manage ? (
                        <Button variant="ghost" onClick={() => setCopying(form)}>
                          {t('forms.list.copy')}
                        </Button>
                      ) : null}
                      <Link
                        to={`/forms/${form.id}`}
                        className="rounded-md border border-border-subtle px-3 py-1.5 text-content hover:bg-surface-muted"
                      >
                        {t('forms.list.open')}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manage ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-content">{t('forms.templates.title')}</h2>
            <p className="text-sm text-content-muted">{t('forms.templates.subtitle')}</p>
          </div>
          {templates.isPending ? <LoadingState /> : null}
          {templates.isError ? <ErrorState onRetry={() => void templates.refetch()} /> : null}
          {copyTemplate.isError ? (
            <ErrorState
              requestId={
                copyTemplate.error instanceof ApiRequestError
                  ? copyTemplate.error.requestId
                  : undefined
              }
            />
          ) : null}
          {templates.data === undefined ? null : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {templates.data.map((template) => (
                <li
                  key={template.key}
                  className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-xs uppercase tracking-wide text-content-muted">
                      {t(`forms.templates.category.${template.category}`)}
                    </span>
                    <h3 className="text-base font-semibold text-content">
                      {say(template.title, locale)}
                    </h3>
                    <p className="text-sm text-content-muted">
                      {say(template.description, locale)}
                    </p>
                    <p className="text-xs text-content-muted">
                      {t('forms.templates.fields', { count: template.fieldCount })}
                    </p>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setPreviewing(template.key)}>
                      {t('forms.templates.preview')}
                    </Button>
                    <Button
                      busy={copyTemplate.isPending && copyTemplate.variables === template.key}
                      onClick={() => startFromTemplate(template.key)}
                    >
                      {t('forms.templates.use')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <CreateDialog open={creating} locale={locale} onClose={() => setCreating(false)} />
      <CopyDialog form={copying} onClose={() => setCopying(undefined)} />
      <TemplatePreview
        templateKey={previewing}
        locale={locale}
        onClose={() => setPreviewing(undefined)}
        onUse={(key) => {
          setPreviewing(undefined);
          startFromTemplate(key);
        }}
      />
    </div>
  );
}

function CreateDialog({
  open,
  locale,
  onClose,
}: {
  open: boolean;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateForm();
  const [title, setTitle] = useState('');

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (title.trim() === '') {
      return;
    }
    create.mutate(
      { title: title.trim(), locale },
      { onSuccess: (detail) => void navigate(`/forms/${detail.form.id}`) },
    );
  };

  return (
    <Dialog open={open} title={t('forms.create.title')} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label={t('forms.create.name')}
          placeholder={t('forms.create.placeholder')}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        {create.isError ? (
          <ErrorState
            requestId={create.error instanceof ApiRequestError ? create.error.requestId : undefined}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={create.isPending} disabled={title.trim() === ''}>
            {t('forms.create.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CopyDialog({ form, onClose }: { form: FormListItem | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const copy = useCopyForm();
  const [title, setTitle] = useState<string | undefined>(undefined);
  const value =
    title ?? (form === undefined ? '' : t('forms.copy.defaultName', { name: form.title }));

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (form === undefined || value.trim() === '') {
      return;
    }
    copy.mutate(
      { formId: form.id, title: value.trim() },
      { onSuccess: (detail) => void navigate(`/forms/${detail.form.id}`) },
    );
  };

  return (
    <Dialog
      open={form !== undefined}
      title={t('forms.copy.title', { name: form?.title ?? '' })}
      onClose={() => {
        setTitle(undefined);
        onClose();
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p>{t('forms.copy.body')}</p>
        <Field
          label={t('forms.copy.name')}
          value={value}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        {copy.isError ? (
          <ErrorState
            requestId={copy.error instanceof ApiRequestError ? copy.error.requestId : undefined}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={copy.isPending} disabled={value.trim() === ''}>
            {t('forms.copy.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TemplatePreview({
  templateKey,
  locale,
  onClose,
  onUse,
}: {
  templateKey: string | undefined;
  locale: string;
  onClose: () => void;
  onUse: (key: string) => void;
}) {
  const { t } = useTranslation();
  const template = useTemplate(templateKey);

  return (
    <Dialog
      open={templateKey !== undefined}
      wide
      title={
        template.data === undefined
          ? t('forms.templates.preview')
          : say(template.data.title, locale)
      }
      onClose={onClose}
      footer={
        templateKey === undefined ? undefined : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button onClick={() => onUse(templateKey)}>{t('forms.templates.use')}</Button>
          </>
        )
      }
    >
      {template.isPending ? <LoadingState /> : null}
      {template.data === undefined ? null : (
        <TemplateForm template={template.data} locale={locale} />
      )}
    </Dialog>
  );
}

/** A template, fillable but going nowhere — the quickest way to judge whether it fits. */
function TemplateForm({ template, locale }: { template: Template; locale: string }) {
  const compiled = useMemo(() => compileDefinition(template.definition), [template.definition]);
  const [state, setState] = useState<FormState | undefined>(() =>
    compiled.ok ? createFormState(compiled.form) : undefined,
  );
  if (!compiled.ok || state === undefined) {
    return null;
  }
  const view = viewForm(compiled.form, state);
  return (
    <FormRenderer
      form={compiled.form}
      state={state}
      view={view}
      viewport="desktop"
      locale={locale}
      onEvent={(event) =>
        setState((current) => current && transition(compiled.form, current, event).state)
      }
    />
  );
}
