'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '~/components/ui';
import { formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * What is failing quietly (P19).
 *
 * Three tables already knew: `sync_reports` for a phone that cannot get its
 * work in, `billing_events` for a delivery recorded but never applied, and
 * `jobs` for background work that gave up. None had a screen, so each was found
 * by a customer first. This is the screen, over a window, across every company.
 */
export default function HealthPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);

  const health = useQuery({
    queryKey: ['platform', 'health', days],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/health', {
        params: { query: { days } },
      });
      return data;
    },
  });

  return (
    <main className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.health.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.health.subtitle')}</p>
      </header>

      <label className="flex max-w-48 flex-col gap-1 text-sm">
        <span className="font-medium text-content">
          {t('platform.health.days', { count: days })}
        </span>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
        >
          <option value={1}>1</option>
          <option value={7}>7</option>
          <option value={30}>30</option>
        </select>
      </label>

      {health.isPending ? <LoadingState /> : null}

      {health.isError ? (
        <ErrorState
          requestId={health.error instanceof ApiRequestError ? health.error.requestId : undefined}
          onRetry={() => void health.refetch()}
        />
      ) : null}

      {health.isSuccess && health.data !== undefined ? (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-content">
              {t('platform.health.jobs.title')}
            </h2>
            <dl className="grid max-w-xl gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-border-subtle bg-surface p-4 text-start">
                <dt className="text-xs uppercase tracking-wide text-content-muted">
                  {t('platform.health.jobs.deadLettered')}
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-content">
                  {health.data.jobs.deadLettered}
                </dd>
              </div>
              <div className="rounded-lg border border-border-subtle bg-surface p-4 text-start">
                <dt className="text-xs uppercase tracking-wide text-content-muted">
                  {t('platform.health.jobs.retrying')}
                </dt>
                <dd className="text-2xl font-semibold tabular-nums text-content">
                  {health.data.jobs.retrying}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-content-muted">{t('platform.health.jobs.hint')}</p>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-content">
              {t('platform.health.sync.title')}
            </h2>
            {health.data.sync.items.length === 0 ? (
              <EmptyState title={t('platform.health.sync.empty')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle text-content-muted">
                      <th scope="col" className="py-2 pe-3 text-start">
                        {t('platform.health.sync.company')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-start">
                        {t('platform.health.sync.person')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-end">
                        {t('platform.health.sync.runs')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-end">
                        {t('platform.health.sync.failed')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-end">
                        {t('platform.health.sync.partial')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-end">
                        {t('platform.health.sync.refused')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-end">
                        {t('platform.health.sync.conflicts')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-end">
                        {t('platform.health.sync.uploadsFailed')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-start">
                        {t('platform.health.sync.waiting')}
                      </th>
                      <th scope="col" className="py-2 pe-3 text-start">
                        {t('platform.health.sync.lastSeen')}
                      </th>
                      <th scope="col" className="py-2 text-start">
                        {t('platform.health.sync.version')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.data.sync.items.map((row) => (
                      <tr
                        key={`${row.tenantId}-${row.userId}`}
                        className="border-b border-border-subtle"
                      >
                        <td className="py-2 pe-3 font-mono text-xs">
                          <Link
                            href={`/platform/companies/${row.tenantId}`}
                            className="text-accent underline-offset-2 hover:underline"
                          >
                            {row.tenantId.slice(0, 8)}
                          </Link>
                        </td>
                        <td className="py-2 pe-3 font-mono text-xs">{row.userId.slice(0, 8)}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.runs}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.failedRuns}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.partialRuns}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.rejected}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.conflicts}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.uploadsFailed}</td>
                        <td className="py-2 pe-3 tabular-nums">
                          {t('platform.health.sync.waitingDetail', {
                            changes: row.queueDepth,
                            uploads: row.pendingUploads,
                          })}
                        </td>
                        <td className="py-2 pe-3">{formatWhen(row.lastReportAt)}</td>
                        <td className="py-2 font-mono text-xs">{row.appVersion ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-content">
              {t('platform.health.webhooks.title')}
            </h2>
            <p className="text-sm text-content-muted">
              {t('platform.health.webhooks.summary', {
                received: health.data.webhooks.received,
                applied: health.data.webhooks.applied,
                failed: health.data.webhooks.failed,
                unmatched: health.data.webhooks.unmatched,
                pending: health.data.webhooks.pending,
              })}
            </p>
            {health.data.webhooks.items.length === 0 ? (
              <EmptyState title={t('platform.health.webhooks.empty')} />
            ) : (
              <table className="w-full max-w-4xl border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-content-muted">
                    <th scope="col" className="py-2 pe-3 text-start">
                      {t('platform.health.webhooks.type')}
                    </th>
                    <th scope="col" className="py-2 pe-3 text-start">
                      {t('platform.health.webhooks.company')}
                    </th>
                    <th scope="col" className="py-2 pe-3 text-start">
                      {t('platform.health.webhooks.when')}
                    </th>
                    <th scope="col" className="py-2 text-start">
                      {t('platform.health.webhooks.outcome')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {health.data.webhooks.items.map((event) => (
                    <tr key={event.id} className="border-b border-border-subtle align-top">
                      <td className="py-2 pe-3 font-mono text-xs">{event.type}</td>
                      <td className="py-2 pe-3 font-mono text-xs">
                        {event.tenantId === null ? '—' : event.tenantId.slice(0, 8)}
                      </td>
                      <td className="py-2 pe-3">{formatWhen(event.receivedAt)}</td>
                      <td className="py-2">
                        <span
                          className={
                            event.outcome === 'applied'
                              ? 'text-content'
                              : event.outcome === 'pending'
                                ? 'text-content-muted'
                                : 'font-medium text-danger'
                          }
                        >
                          {t(`platform.health.webhooks.outcomes.${event.outcome}`)}
                        </span>
                        {event.error === null ? null : (
                          <span className="block max-w-prose text-xs text-content-muted">
                            {event.error}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
