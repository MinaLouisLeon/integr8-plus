'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Panel } from '~/components/platform-bits';
import { EmptyState, ErrorState, LoadingState } from '~/components/ui';
import { formatBytes, formatWhen } from '~/lib/platform-format';
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
  const { t } = useTranslation();

  const overview = useQuery({
    queryKey: ['platform', 'storage'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/storage');
      return data;
    },
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
          <Fact label="Total" value={money(cost.total)} />
        </dl>
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

/** Dollars, because that is what Cloudflare bills in. */
function money(value: number): string {
  return `$${value.toFixed(2)}`;
}
