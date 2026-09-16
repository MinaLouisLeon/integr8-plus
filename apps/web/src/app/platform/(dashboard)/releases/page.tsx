'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '~/components/ui';
import { formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * Which app versions are actually in the field (P15).
 *
 * Mobile only, and the subtitle says so rather than leaving a gap for somebody
 * to read as "no desktop users". `sync_reports.app_version` is the only place a
 * client version is written down; desktop and web send theirs on every request
 * and nothing records it. That is a gap to close by recording it, not by
 * guessing here.
 */
export default function ReleasesPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);

  const releases = useQuery({
    queryKey: ['platform', 'releases', days],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/releases', {
        params: { query: { days } },
      });
      return data?.items ?? [];
    },
  });

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.releases.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.releases.subtitle')}</p>
      </header>

      <label className="flex max-w-48 flex-col gap-1 text-sm">
        <span className="font-medium text-content">
          {t('platform.releases.days', { count: days })}
        </span>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
        >
          <option value={7}>7</option>
          <option value={30}>30</option>
          <option value={90}>90</option>
        </select>
      </label>

      {releases.isPending ? <LoadingState /> : null}

      {releases.isError ? (
        <ErrorState
          requestId={
            releases.error instanceof ApiRequestError ? releases.error.requestId : undefined
          }
          onRetry={() => void releases.refetch()}
        />
      ) : null}

      {releases.isSuccess && releases.data.length === 0 ? (
        <EmptyState title={t('platform.releases.empty')} />
      ) : null}

      {releases.isSuccess && releases.data.length > 0 ? (
        <table className="w-full max-w-2xl border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-content-muted">
              <th scope="col" className="py-2 text-start">
                {t('platform.releases.version')}
              </th>
              <th scope="col" className="py-2 text-end">
                {t('platform.releases.devices')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('platform.releases.lastSeen')}
              </th>
            </tr>
          </thead>
          <tbody>
            {releases.data.map((release) => (
              <tr
                key={`${release.clientApp}-${release.version}`}
                className="border-b border-border-subtle"
              >
                <td className="py-2 font-mono">{release.version}</td>
                <td className="py-2 text-end tabular-nums">{release.devices}</td>
                <td className="py-2">{formatWhen(release.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  );
}
