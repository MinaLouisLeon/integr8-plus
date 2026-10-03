'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Panel } from '~/components/platform-bits';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatWhen, pickMessage } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * Announcements: one banner, three apps (P15).
 *
 * The message is written per language rather than once, because the field is
 * full of people who do not read English and the one announcement that matters
 * is the one saying the system is going down. This screen writes English and
 * leaves room for more — a translator adds tags to the same announcement rather
 * than posting a second one.
 */
export default function AnnouncementsPage() {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();

  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('info');
  const [dismissible, setDismissible] = useState(true);

  const announcements = useQuery({
    queryKey: ['platform', 'announcements'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/announcements');
      return data?.items ?? [];
    },
  });

  const post = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/announcements', {
        body: {
          severity,
          dismissible,
          message: { en: message.trim() },
          tenantId: null,
          endsAt: null,
        },
      });
    },
    onSuccess: () => {
      setMessage('');
      void queries.invalidateQueries({ queryKey: ['platform', 'announcements'] });
    },
  });

  const end = useMutation({
    mutationFn: async (id: string) => {
      await platformClient().POST('/v1/platform/announcements/{id}/end', {
        params: { path: { id } },
      });
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['platform', 'announcements'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    post.mutate();
  };

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.announcements.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.announcements.subtitle')}</p>
      </header>

      <Panel title={t('platform.announcements.create')}>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <Field
            label={t('platform.announcements.message')}
            required
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            {...(post.isError ? { error: messageForError(post.error, t) } : {})}
          />
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-content">
                {t('platform.announcements.severity')}
              </span>
              <select
                value={severity}
                onChange={(event) =>
                  setSeverity(event.target.value as 'info' | 'warning' | 'critical')
                }
                className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
              >
                <option value="info">{t('platform.announcements.info')}</option>
                <option value="warning">{t('platform.announcements.warning')}</option>
                <option value="critical">{t('platform.announcements.critical')}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-content-muted">
              <input
                type="checkbox"
                checked={dismissible}
                onChange={(event) => setDismissible(event.target.checked)}
              />
              {t('platform.announcements.dismissible')}
            </label>
            <Button type="submit" busy={post.isPending} disabled={message.trim() === ''}>
              {t('platform.announcements.create')}
            </Button>
          </div>
        </form>
      </Panel>

      {announcements.isPending ? <LoadingState /> : null}

      {announcements.isError ? (
        <ErrorState
          requestId={
            announcements.error instanceof ApiRequestError
              ? announcements.error.requestId
              : undefined
          }
          onRetry={() => void announcements.refetch()}
        />
      ) : null}

      {announcements.isSuccess && announcements.data.length === 0 ? (
        <EmptyState title={t('platform.announcements.empty')} />
      ) : null}

      {announcements.isSuccess && announcements.data.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {announcements.data.map((announcement) => (
            <li
              key={announcement.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3 text-sm"
            >
              <span className="flex flex-col gap-1">
                <span className="text-content">
                  {pickMessage(announcement.message, i18n.language)}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-content-muted">
                  <Badge
                    tone={
                      announcement.severity === 'critical'
                        ? 'danger'
                        : announcement.severity === 'warning'
                          ? 'warning'
                          : 'muted'
                    }
                  >
                    {t(`platform.announcements.${announcement.severity}`)}
                  </Badge>
                  <span>
                    {announcement.tenantId === null
                      ? t('platform.announcements.everybody')
                      : t('platform.announcements.oneCompany')}
                  </span>
                  <span>
                    {t('platform.announcements.starts')} {formatWhen(announcement.startsAt)}
                  </span>
                  <span>
                    {t('platform.announcements.ends')}{' '}
                    {announcement.endsAt === null
                      ? t('platform.announcements.never')
                      : formatWhen(announcement.endsAt)}
                  </span>
                </span>
              </span>
              {announcement.endsAt === null || new Date(announcement.endsAt) > new Date() ? (
                <Button
                  variant="secondary"
                  busy={end.isPending}
                  onClick={() => end.mutate(announcement.id)}
                >
                  {t('platform.announcements.end')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
