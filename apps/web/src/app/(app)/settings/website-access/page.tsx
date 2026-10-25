'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorState, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { apiClient } from '~/lib/session';

interface WebsiteAccessSettings {
  websiteFilesEnabled: boolean;
  websiteJobsEnabled: boolean;
  websiteQuotesEnabled: boolean;
  websiteInvoicesEnabled: boolean;
}

export default function WebsiteAccessPage() {
  const settings = useQuery({
    queryKey: ['settings', 'website-access'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/settings/website-access');
      return data;
    },
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError || settings.data === undefined) {
    return (
      <ErrorState
        requestId={settings.error instanceof ApiRequestError ? settings.error.requestId : undefined}
        onRetry={() => void settings.refetch()}
      />
    );
  }

  return <WebsiteAccessForm initial={settings.data} />;
}

function WebsiteAccessForm({ initial }: { initial: WebsiteAccessSettings }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [files, setFiles] = useState(initial.websiteFilesEnabled);
  const [jobs, setJobs] = useState(initial.websiteJobsEnabled);
  const [quotes, setQuotes] = useState(initial.websiteQuotesEnabled);
  const [invoices, setInvoices] = useState(initial.websiteInvoicesEnabled);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: async () =>
      apiClient().PATCH('/v1/settings/website-access', {
        body: {
          websiteFilesEnabled: files,
          websiteJobsEnabled: jobs,
          websiteQuotesEnabled: quotes,
          websiteInvoicesEnabled: invoices,
        },
      }),
    onSuccess: () => {
      setSaved(true);
      setError(undefined);
      void queries.invalidateQueries({ queryKey: ['settings', 'website-access'] });
    },
    onError: (failure) => {
      setSaved(false);
      setError(messageForError(failure, t));
    },
  });

  const switches = [
    { key: 'files', checked: files, set: setFiles },
    { key: 'jobs', checked: jobs, set: setJobs },
    { key: 'quotes', checked: quotes, set: setQuotes },
    { key: 'invoices', checked: invoices, set: setInvoices },
  ] as const;

  return (
    <main className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">
          {t('workspace.settings.websiteAccess.title')}
        </h1>
        <p className="text-sm text-content-muted">{t('workspace.settings.websiteAccess.intro')}</p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          save.mutate();
        }}
        className="flex max-w-xl flex-col gap-6"
      >
        <div className="flex flex-col gap-3">
          {switches.map((item) => (
            <label key={item.key} className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                checked={item.checked}
                onChange={(event) => item.set(event.target.checked)}
              />
              {t(`workspace.settings.websiteAccess.${item.key}`)}
            </label>
          ))}
        </div>

        {error === undefined ? null : (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" busy={save.isPending}>
            {t('workspace.settings.save')}
          </Button>
          {saved ? (
            <span role="status" className="text-sm text-content-muted">
              {t('workspace.settings.saved')}
            </span>
          ) : null}
        </div>
      </form>
    </main>
  );
}
