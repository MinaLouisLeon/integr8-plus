'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * The platform audit log (P15).
 *
 * Paged by keyset rather than by page number, because this is a table that is
 * being written to while it is being read: with an offset, an entry written
 * between two pages pushes a row from one page onto the next and it is never
 * seen. "Show more" carries the last row's position instead.
 */
export default function AuditPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const entries = useInfiniteQuery({
    queryKey: ['platform', 'audit', search],
    initialPageParam: undefined as { occurredAt: string; id: string } | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await platformClient().GET('/v1/platform/audit', {
        params: {
          query: {
            ...(search.trim() === '' ? {} : { search: search.trim() }),
            ...(pageParam === undefined
              ? {}
              : { beforeOccurredAt: pageParam.occurredAt, beforeId: pageParam.id }),
            limit: 50,
          },
        },
      });
      return data;
    },
    getNextPageParam: (page) => page?.next ?? undefined,
  });

  const rows = (entries.data?.pages ?? []).flatMap((page) => page?.entries ?? []);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.audit.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.audit.subtitle')}</p>
      </header>

      <div className="max-w-md">
        <Field
          label={t('platform.audit.search')}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {entries.isPending ? <LoadingState /> : null}

      {entries.isError ? (
        <ErrorState
          requestId={entries.error instanceof ApiRequestError ? entries.error.requestId : undefined}
          onRetry={() => void entries.refetch()}
        />
      ) : null}

      {entries.isSuccess && rows.length === 0 ? (
        <EmptyState title={t('platform.audit.empty')} />
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-content-muted">
                  <th scope="col" className="py-2 text-start">
                    {t('platform.audit.when')}
                  </th>
                  <th scope="col" className="py-2 text-start">
                    {t('platform.audit.who')}
                  </th>
                  <th scope="col" className="py-2 text-start">
                    {t('platform.audit.what')}
                  </th>
                  <th scope="col" className="py-2 text-start">
                    {t('platform.audit.company')}
                  </th>
                  <th scope="col" className="py-2 text-start">
                    {t('platform.audit.reason')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id} className="border-b border-border-subtle align-top">
                    <td className="py-2 whitespace-nowrap">{formatWhen(entry.occurredAt)}</td>
                    <td className="py-2">{entry.actorLabel}</td>
                    <td className="py-2 font-mono text-xs">{entry.action}</td>
                    <td className="py-2">{entry.tenantSlug ?? '—'}</td>
                    <td className="py-2 text-content-muted">{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {entries.hasNextPage ? (
            <Button
              variant="secondary"
              busy={entries.isFetchingNextPage}
              onClick={() => void entries.fetchNextPage()}
            >
              {t('platform.audit.more')}
            </Button>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
