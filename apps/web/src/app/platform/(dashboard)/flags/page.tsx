'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Panel } from '~/components/platform-bits';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { platformClient } from '~/lib/platform-session';

/**
 * Feature flags, platform-wide (P15).
 *
 * This screen is only about what a flag *is* and what everybody gets by
 * default. Turning one on or off for one company happens on that company's own
 * page, where you can see who you are doing it to.
 */
export default function FlagsPage() {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [defaultEnabled, setDefaultEnabled] = useState(false);

  const flags = useQuery({
    queryKey: ['platform', 'flags'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/flags');
      return data?.items ?? [];
    },
  });

  const declare = useMutation({
    mutationFn: async () => {
      await platformClient().PUT('/v1/platform/flags/{key}', {
        params: { path: { key: key.trim() } },
        body: { description: description.trim(), defaultEnabled },
      });
    },
    onSuccess: () => {
      setKey('');
      setDescription('');
      void queries.invalidateQueries({ queryKey: ['platform', 'flags'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    declare.mutate();
  };

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.flags.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.flags.subtitle')}</p>
      </header>

      <Panel title={t('platform.flags.declare')}>
        <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
          <div className="min-w-48">
            <Field
              label={t('platform.flags.key')}
              required
              value={key}
              onChange={(event) => setKey(event.target.value)}
              // The API accepts lower case, digits and underscores; saying so
              // here means a typo is a message rather than a rejected request.
              pattern="[a-z][a-z0-9_]*"
            />
          </div>
          <div className="min-w-64 flex-1">
            <Field
              label={t('platform.flags.description')}
              required
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              {...(declare.isError ? { error: messageForError(declare.error, t) } : {})}
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-content-muted">
            <input
              type="checkbox"
              checked={defaultEnabled}
              onChange={(event) => setDefaultEnabled(event.target.checked)}
            />
            {t('platform.flags.defaultEnabled')}
          </label>
          <Button type="submit" busy={declare.isPending} disabled={key.trim() === ''}>
            {t('platform.flags.declare')}
          </Button>
        </form>
      </Panel>

      {flags.isPending ? <LoadingState /> : null}

      {flags.isError ? (
        <ErrorState
          requestId={flags.error instanceof ApiRequestError ? flags.error.requestId : undefined}
          onRetry={() => void flags.refetch()}
        />
      ) : null}

      {flags.isSuccess && flags.data.length === 0 ? (
        <EmptyState title={t('platform.flags.empty')} />
      ) : null}

      {flags.isSuccess && flags.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {flags.data.map((flag) => (
            <li
              key={flag.key}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-2 text-sm"
            >
              <span className="flex flex-col">
                <span className="font-mono text-content">{flag.key}</span>
                <span className="text-content-muted">{flag.description}</span>
              </span>
              <Badge tone={flag.defaultEnabled ? 'ok' : 'muted'}>
                {flag.defaultEnabled ? t('platform.flags.on') : t('platform.flags.off')}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
