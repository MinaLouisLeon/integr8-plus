import { ApiRequestError } from '@integr8/api-client';
import { ROLES } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { type FormDetail, type Role, useUpdateSettings, useVersions } from '../api';

/** Every published version, newest first, with what changed in each. */
export function HistoryPanel({ formId, locale }: { formId: string; locale: string }) {
  const { t } = useTranslation();
  const versions = useVersions(formId);

  if (versions.isPending) {
    return <LoadingState />;
  }
  if (versions.isError) {
    return (
      <ErrorState
        requestId={versions.error instanceof ApiRequestError ? versions.error.requestId : undefined}
        onRetry={() => void versions.refetch()}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-y-auto p-6 text-start">
      <h2 className="text-xl font-semibold text-content">{t('forms.history.title')}</h2>
      {versions.data.length === 0 ? (
        <EmptyState title={t('forms.history.empty')} body="" />
      ) : (
        <ol className="flex flex-col gap-3">
          {versions.data.map((version) => {
            const summary = summarise(version.changes);
            return (
              <li
                key={version.id}
                className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border-subtle bg-surface p-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <h3 className="text-base font-semibold text-content">
                      {t('forms.history.version', { number: version.versionNumber ?? 0 })}
                    </h3>
                    {version.publishedAt === null ? null : (
                      <span className="text-xs text-content-muted">
                        {t('forms.history.published', {
                          when: formatDateTime(version.publishedAt, { locale }),
                        })}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-content">
                    {version.changeNote ?? t('forms.history.noNote')}
                  </p>
                  {summary === undefined ? null : (
                    <p className="text-xs text-content-muted">
                      {t('forms.history.summary', summary)}
                      {summary.breaking > 0
                        ? ` · ${t('forms.history.breaking', { count: summary.breaking })}`
                        : ''}
                    </p>
                  )}
                </div>
                <Link
                  to={`/forms/${formId}/versions/${version.id}`}
                  className="rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content hover:bg-surface-muted"
                >
                  {t('forms.history.view')}
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function summarise(changes: Record<string, unknown> | null) {
  if (changes === null || !Array.isArray(changes.changes) || !Array.isArray(changes.breaking)) {
    return undefined;
  }
  const kinds = (changes.changes as { kind: string }[]).map((change) => change.kind);
  return {
    added: kinds.filter((kind) => kind === 'added').length,
    removed: kinds.filter((kind) => kind === 'removed').length,
    changed: kinds.filter((kind) => kind === 'changed' || kind === 'moved').length,
    breaking: changes.breaking.length,
  };
}

/**
 * Who fills the form in and what closing a job needs.
 *
 * Not versioned: these describe how the company uses the form, not what the
 * form asks, so changing them does not need a publish. Job types arrive later,
 * and the setting is shown — disabled, with a reason — so nobody wonders where
 * it went.
 */
export function SettingsPanel({ detail }: { detail: FormDetail }) {
  const { t } = useTranslation();
  const update = useUpdateSettings(detail.form.id);
  const [title, setTitle] = useState(detail.form.title);
  const [roles, setRoles] = useState<Role[]>(detail.form.fillRoles);
  const [signature, setSignature] = useState(detail.form.signatureRequired);
  const [saved, setSaved] = useState(false);

  const submit = () => {
    setSaved(false);
    update.mutate(
      { title: title.trim(), fillRoles: roles, signatureRequired: signature },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 overflow-y-auto p-6 text-start">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-content">{t('forms.settings.title')}</h2>
        <p className="text-sm text-content-muted">{t('forms.settings.note')}</p>
      </div>

      <Field
        label={t('forms.settings.name')}
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-content">
          {t('forms.settings.fillRoles')}
        </legend>
        {ROLES.map((role) => (
          <label key={role} className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={roles.includes(role)}
              onChange={(event) =>
                setRoles((current) =>
                  event.target.checked
                    ? ROLES.filter((candidate) => candidate === role || current.includes(candidate))
                    : current.filter((candidate) => candidate !== role),
                )
              }
            />
            {t(`workspace.role.${role}`)}
          </label>
        ))}
        {roles.length === 0 ? (
          <p className="text-xs text-danger">{t('forms.settings.fillRolesHint')}</p>
        ) : null}
      </fieldset>

      <label className="flex items-start gap-2 text-sm text-content">
        <input
          type="checkbox"
          className="mt-1"
          checked={signature}
          onChange={(event) => setSignature(event.target.checked)}
        />
        {t('forms.settings.signature')}
      </label>

      <fieldset disabled className="flex flex-col gap-1 opacity-70">
        <legend className="text-sm font-medium text-content">{t('forms.settings.jobTypes')}</legend>
        <p className="text-sm text-content-muted">{t('forms.settings.jobTypesPending')}</p>
      </fieldset>

      {update.isError ? (
        <ErrorState
          requestId={update.error instanceof ApiRequestError ? update.error.requestId : undefined}
        />
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-content">
          {t('forms.settings.saved')}
        </p>
      ) : null}

      <div>
        <Button
          busy={update.isPending}
          disabled={roles.length === 0 || title.trim() === ''}
          onClick={submit}
        >
          {t('forms.settings.save')}
        </Button>
      </div>
    </div>
  );
}
