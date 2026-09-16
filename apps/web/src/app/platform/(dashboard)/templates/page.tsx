'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '~/components/platform-bits';
import { EmptyState, ErrorState, LoadingState } from '~/components/ui';
import { formatWhen, pickMessage } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * The global form template library (P15).
 *
 * Read-only here on purpose. A template is a form definition, and editing a
 * form definition is what the form builder is for — a second, worse editor on
 * this screen would be a place to produce a template that does not compile.
 * Adding and replacing templates is `PUT /v1/platform/form-templates/{key}`,
 * which is how `db templates` loads the ones the product ships with.
 */
export default function TemplatesPage() {
  const { t, i18n } = useTranslation();

  const templates = useQuery({
    queryKey: ['platform', 'templates'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/form-templates');
      return data?.items ?? [];
    },
  });

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.templates.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.templates.subtitle')}</p>
      </header>

      {templates.isPending ? <LoadingState /> : null}

      {templates.isError ? (
        <ErrorState
          requestId={
            templates.error instanceof ApiRequestError ? templates.error.requestId : undefined
          }
          onRetry={() => void templates.refetch()}
        />
      ) : null}

      {templates.isSuccess && templates.data.length === 0 ? (
        <EmptyState title={t('platform.templates.empty')} />
      ) : null}

      {templates.isSuccess && templates.data.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {templates.data.map((template) => (
            <li
              key={template.key}
              className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-3 text-sm"
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-content">
                  {pickMessage(template.title, i18n.language)}
                </span>
                <span className="text-content-muted">
                  {pickMessage(template.description, i18n.language)}
                </span>
                <span className="font-mono text-xs text-content-muted">{template.key}</span>
              </span>
              <span className="flex items-center gap-3">
                <Badge tone="muted">{template.category}</Badge>
                <span className="text-content-muted">
                  {t('platform.templates.updated')} {formatWhen(template.updatedAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
