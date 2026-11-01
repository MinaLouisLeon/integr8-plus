'use client';

import { ApiRequestError } from '@integr8/api-client';
import { previousMonth, utcMonthOf } from '@integr8/core';
import { formatCurrency, useTranslation } from '@integr8/i18n';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Panel } from '~/components/platform-bits';
import { EmptyState, ErrorState, LoadingState } from '~/components/ui';
import { formatBytes, formatGbMonths, formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * Storage across the whole platform (P16).
 *
 * Three questions on one screen: how much is stored, what it is likely to cost,
 * and whether anybody's number is wrong. The third is the one that matters —
 * the ledger is what we bill from, so a company whose ledger disagrees with
 * Cloudflare is a company we are billing incorrectly.
 */
export default function StoragePage() {
  const { t, i18n } = useTranslation();
  const money = (value: number) => formatCurrency(value, 'USD', { locale: i18n.language });
  // The "Over allowance" list covers this month or the last one: the one being
  // invoiced is usually last month, once it is over.
  const [whichMonth, setWhichMonth] = useState<'this' | 'last'>('this');
  const thisMonth = utcMonthOf(new Date());
  const month = whichMonth === 'this' ? thisMonth : previousMonth(thisMonth);

  const overview = useQuery({
    queryKey: ['platform', 'storage', month],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/storage', {
        params: { query: { month } },
      });
      return data;
    },
    // Switching month keeps the rest of the screen in place while it loads.
    placeholderData: keepPreviousData,
  });

  if (overview.isPending) {
    return <LoadingState />;
  }

  if (overview.isError || overview.data === undefined) {
    return (
      <ErrorState
        requestId={overview.error instanceof ApiRequestError ? overview.error.requestId : undefined}
        onRetry={() => void overview.refetch()}
      />
    );
  }

  const data = overview.data;
  const cost = data.projectedMonthlyCost;
  // Dollars, because that is what Cloudflare bills in; written the reader's way.

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.storage.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.storage.subtitle')}</p>
      </header>

      <Panel title={t('platform.storage.title')}>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <Fact label={t('platform.storage.total')} value={formatBytes(data.totalBytes)} />
          <Fact label={t('platform.storage.objects')} value={data.totalObjects.toLocaleString()} />
          <Fact label={t('platform.storage.companies')} value={String(data.companies)} />
        </dl>
      </Panel>

      <Panel
        title={t('platform.storage.projected')}
        description={t('platform.storage.projectedHint')}
      >
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Fact label={t('platform.storage.storageCost')} value={money(cost.storage)} />
          <Fact label={t('platform.storage.classA')} value={money(cost.classA)} />
          <Fact label={t('platform.storage.classB')} value={money(cost.classB)} />
          <Fact label={t('platform.storage.totalCost')} value={money(cost.total)} />
        </dl>
      </Panel>

      <Panel
        title={t('platform.storage.overAllowance.title')}
        description={t('platform.storage.overAllowance.description')}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-content-muted">{t('platform.storage.overAllowance.month')}</span>
            <select
              value={whichMonth}
              onChange={(event) => setWhichMonth(event.target.value === 'last' ? 'last' : 'this')}
              className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-content"
            >
              <option value="this">
                {t('platform.storage.overAllowance.thisMonth')} ({thisMonth})
              </option>
              <option value="last">
                {t('platform.storage.overAllowance.lastMonth')} ({previousMonth(thisMonth)})
              </option>
            </select>
          </label>
        }
      >
        {data.overAllowance.companies.length === 0 ? (
          <p className="text-sm text-success">{t('platform.storage.overAllowance.none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-content-muted">
                  <th scope="col" className="py-1 text-start">
                    {t('platform.storage.overAllowance.company')}
                  </th>
                  <th scope="col" className="py-1 text-start">
                    {t('platform.storage.overAllowance.plan')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.storage.overAllowance.overNow')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.storage.overAllowance.daysOver')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.storage.overAllowance.peak')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.storage.overAllowance.toInvoice')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.overAllowance.companies.map((row) => (
                  <tr key={row.tenantId} className="border-b border-border-subtle">
                    <td className="py-1">
                      <Link
                        href={`/platform/companies/${row.tenantId}`}
                        className="text-content underline-offset-2 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="ms-2 font-mono text-xs text-content-muted">{row.slug}</span>
                    </td>
                    <td className="py-1">{t(`common.plan.${row.plan}`)}</td>
                    <td className="py-1 text-end tabular-nums">
                      {row.overNowBytes > 0 ? (
                        <Badge tone="warning">{formatBytes(row.overNowBytes)}</Badge>
                      ) : (
                        <span className="text-content-muted">
                          {t('platform.storage.overAllowance.backUnder')}
                        </span>
                      )}
                    </td>
                    <td className="py-1 text-end tabular-nums">
                      {row.daysOver} / {data.overAllowance.daysInMonth}
                    </td>
                    <td className="py-1 text-end tabular-nums">{formatBytes(row.peakBytes)}</td>
                    <td className="py-1 text-end font-medium tabular-nums">
                      {formatGbMonths(row.averageBytes, i18n.language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title={t('platform.storage.driftedCompanies')}
        description={t('platform.storage.reconciliationHint')}
      >
        {data.drifted.length === 0 ? (
          <p className="text-sm text-success">{t('platform.storage.noDrift')}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.drifted.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-2"
              >
                <Link
                  href={`/platform/companies/${row.tenantId}`}
                  className="font-mono text-xs text-content underline-offset-2 hover:underline"
                >
                  {row.tenantId}
                </Link>
                <span className="flex flex-wrap items-center gap-3 text-content-muted">
                  <span>
                    {t('platform.storage.ledger')} {formatBytes(row.ledgerBytes)}
                  </span>
                  <span>
                    {t('platform.storage.cloudflare')} {formatBytes(row.cloudflareBytes ?? 0)}
                  </span>
                  <Badge tone="danger">
                    {t('platform.storage.drift')} {formatBytes(Math.abs(row.driftBytes ?? 0))}
                  </Badge>
                  <span>{formatWhen(row.ranAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t('platform.storage.tasks')}>
        {data.tasks.length === 0 ? (
          <EmptyState title={t('platform.storage.noTrend')} />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-content-muted">
                <th scope="col" className="py-1 text-start">
                  {t('platform.storage.taskName')}
                </th>
                <th scope="col" className="py-1 text-start">
                  {t('platform.storage.lastRun')}
                </th>
                <th scope="col" className="py-1 text-start">
                  {t('platform.storage.lastFinished')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.map((task) => (
                <tr key={task.task} className="border-b border-border-subtle">
                  <td className="py-1 font-mono text-xs">{task.task}</td>
                  <td className="py-1">{formatWhen(task.lastRunAt)}</td>
                  <td className="py-1">
                    {task.lastFinishedAt === null ? (
                      <Badge tone="warning">{t('platform.storage.neverFinished')}</Badge>
                    ) : (
                      formatWhen(task.lastFinishedAt)
                    )}
                    {task.lastError === null ? null : (
                      <span className="ms-2 text-danger">{task.lastError}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-content-muted">{label}</dt>
      <dd className="font-medium text-content">{value}</dd>
    </div>
  );
}
