'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '~/components/ui';
import { formatBytes } from '~/lib/platform-format';
import { apiClient } from '~/lib/session';

/**
 * What a company is using, shown to the company (P16).
 *
 * The same numbers the platform sees, from the same endpoint the platform's
 * screen reads — not a friendlier approximation. A customer who is told 94 GB
 * and then refused an upload at what we call 100 has been lied to twice.
 *
 * The warning is the point. A company told at eighty percent can delete
 * something or ask for a bigger plan; a company told at a hundred has already
 * had an engineer fail to upload a photo from a roof.
 */
export default function StoragePage() {
  const { t } = useTranslation();

  const usage = useQuery({
    queryKey: ['storage', 'usage'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/storage/usage');
      return data;
    },
  });

  if (usage.isPending) {
    return <LoadingState />;
  }

  if (usage.isError || usage.data === undefined) {
    return (
      <ErrorState
        requestId={usage.error instanceof ApiRequestError ? usage.error.requestId : undefined}
        onRetry={() => void usage.refetch()}
      />
    );
  }

  const data = usage.data;
  const quota = data.quota;
  const percent = quota.percentUsed ?? 0;

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-content">{t('workspace.storage.title')}</h1>

      {quota.state === 'over' ? (
        <p
          role="status"
          className="rounded-md bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
        >
          {quota.overage === 'block'
            ? t('workspace.storage.full')
            : t('workspace.storage.overage', { amount: formatBytes(quota.overageBytes) })}
        </p>
      ) : null}

      {quota.state === 'warning' ? (
        <p
          role="status"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm font-medium text-warning"
        >
          {t('workspace.storage.warning', { percent: Math.floor(percent) })}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <p className="text-lg text-content">
          {quota.allowanceBytes === null
            ? t('workspace.storage.usedUncapped', { used: formatBytes(data.totalBytes) })
            : t('workspace.storage.used', {
                used: formatBytes(data.totalBytes),
                allowance: formatBytes(quota.allowanceBytes),
              })}
        </p>
        <p className="text-sm text-content-muted">
          {t('workspace.storage.objects', { count: data.totalObjects })}
        </p>

        {quota.allowanceBytes === null ? null : (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
            role="progressbar"
            aria-valuenow={Math.min(100, Math.round(percent))}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('workspace.storage.title')}
          >
            <div
              className={`h-full ${
                quota.state === 'over'
                  ? 'bg-danger'
                  : quota.state === 'warning'
                    ? 'bg-warning'
                    : 'bg-accent'
              }`}
              style={{ width: `${String(Math.min(100, percent))}%` }}
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-content">{t('workspace.storage.breakdown')}</h2>
        <table className="w-full max-w-lg border-collapse text-sm">
          <tbody>
            {data.categories
              .filter((category) => category.objects > 0)
              .map((category) => (
                <tr key={category.category} className="border-b border-border-subtle">
                  <td className="py-1">{t(`platform.storage.${category.category}`)}</td>
                  <td className="py-1 text-end tabular-nums">{category.objects}</td>
                  <td className="py-1 text-end tabular-nums">{formatBytes(category.bytes)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-content">{t('workspace.storage.trend')}</h2>
        {data.trend.length === 0 ? (
          <p className="text-sm text-content-muted">{t('workspace.storage.noTrend')}</p>
        ) : (
          <table className="w-full max-w-lg border-collapse text-sm">
            <tbody>
              {data.trend.slice(0, 30).map((point) => (
                <tr key={point.day} className="border-b border-border-subtle">
                  <td className="py-1">{point.day}</td>
                  <td className="py-1 text-end tabular-nums">{formatBytes(point.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
