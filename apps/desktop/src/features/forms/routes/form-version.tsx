import { ApiRequestError } from '@integr8/api-client';
import {
  compileDefinition,
  createFormState,
  type FormState,
  transition,
  viewForm,
} from '@integr8/form-engine';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorState, LoadingState, Shell } from '~/components/ui';
import { useVersion } from '../api';
import { FormRenderer } from '../components/form-renderer';

/**
 * One past version, exactly as it was published, and unchangeable.
 *
 * It can be filled in to see how it behaved — which is the question somebody
 * reading an old submission usually has — but nothing is saved and nothing
 * can be edited.
 */
export function FormVersionRoute() {
  const { formId = '', versionId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const version = useVersion(formId, versionId);
  const compiled = useMemo(
    () => (version.data === undefined ? undefined : compileDefinition(version.data.definition)),
    [version.data],
  );
  const [state, setState] = useState<FormState | undefined>(undefined);

  if (version.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  if (version.isError || !compiled?.ok) {
    return (
      <Shell>
        <ErrorState
          requestId={version.error instanceof ApiRequestError ? version.error.requestId : undefined}
        />
      </Shell>
    );
  }

  // A repeatable section that needs entries opens with that many (P13b).
  const current =
    state ?? createFormState(compiled.form, {}, { newEntryId: () => crypto.randomUUID() });
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8 text-start">
      <nav className="text-sm">
        <Link to={`/forms/${formId}`} className="text-content-muted hover:underline">
          {t('forms.history.backToForm')}
        </Link>
      </nav>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">
          {t('forms.history.readOnly', { number: version.data.versionNumber ?? 0 })}
        </h1>
        {version.data.publishedAt === null ? null : (
          <p className="text-sm text-content-muted">
            {t('forms.history.published', {
              when: formatDateTime(version.data.publishedAt, { locale }),
            })}
          </p>
        )}
        <p className="text-sm text-content">
          {version.data.changeNote ?? t('forms.history.noNote')}
        </p>
      </header>
      <div className="rounded-lg border border-border-subtle bg-surface p-6">
        <FormRenderer
          form={compiled.form}
          state={current}
          view={viewForm(compiled.form, current)}
          viewport="desktop"
          locale={locale}
          onEvent={(event) => setState(transition(compiled.form, current, event).state)}
        />
      </div>
    </div>
  );
}
