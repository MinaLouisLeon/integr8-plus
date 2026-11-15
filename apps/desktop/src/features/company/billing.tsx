import { ApiRequestError } from '@integr8/api-client';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '~/components/ui';
import { formatBytes } from '~/lib/platform-format';
import { planLabel } from '~/lib/plans';
import { session } from '~/lib/session';

/**
 * What this company is on, and what it is allowed (P17; P42).
 *
 * Integr8 invoices every company directly and sets its plan from the staff
 * app, so there is nothing to pay here: the plan, the limits with the usage
 * against them (the same numbers the API refuses on), and how to reach
 * Integr8 to change any of it.
 */
export function BillingRoute() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const subscription = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/billing/subscription');
      return data;
    },
  });

  if (subscription.isPending) {
    return <LoadingState />;
  }

  if (subscription.isError || subscription.data === undefined) {
    return (
      <ErrorState
        requestId={
          subscription.error instanceof ApiRequestError ? subscription.error.requestId : undefined
        }
        onRetry={() => void subscription.refetch()}
      />
    );
  }

  const data = subscription.data;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('workspace.billing.title')}</h1>
        <p className="text-sm text-content-muted">{t('workspace.billing.subtitle')}</p>
      </header>

      {data.readOnly ? (
        <p
          role="status"
          className="rounded-md bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
        >
          {data.readOnlyReason ?? t('workspace.billing.readOnly')}
        </p>
      ) : null}

      <section className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-lg font-semibold text-content">
            {t('workspace.billing.planNamed', { plan: planLabel(t, data.plan) })}
          </span>
          <span className="text-sm text-content-muted">{t('workspace.billing.invoiced')}</span>
        </div>
        {data.status === 'trialing' && data.trialEndsAt !== null ? (
          <p className="text-sm text-content-muted">
            {t('workspace.billing.trialEnds', {
              when: formatDate(data.trialEndsAt, { locale }),
            })}
          </p>
        ) : null}
        <p className="text-sm text-content-muted">{t('workspace.billing.invoicedBody')}</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-content">{t('workspace.billing.limits')}</h2>
        <dl className="grid gap-4 sm:grid-cols-3">
          <Limit
            label={t('workspace.billing.seats')}
            value={
              data.entitlements.seats === null
                ? t('workspace.billing.seatsUncapped', { used: data.usage.seatsUsed })
                : t('workspace.billing.seatsUsed', {
                    used: data.usage.seatsUsed,
                    allowance: data.entitlements.seats,
                  })
            }
          />
          <Limit
            label={t('workspace.billing.submissions')}
            value={
              data.entitlements.submissionsPerMonth === null
                ? t('workspace.billing.submissionsUncapped', {
                    used: data.usage.submissionsThisMonth,
                  })
                : t('workspace.billing.submissionsUsed', {
                    used: data.usage.submissionsThisMonth,
                    allowance: data.entitlements.submissionsPerMonth,
                  })
            }
          />
          <Limit
            label={t('workspace.billing.storage')}
            value={
              data.entitlements.storageBytes === null
                ? t('workspace.billing.uncapped')
                : formatBytes(data.entitlements.storageBytes)
            }
          />
        </dl>
      </section>
    </main>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-4">
      <dt className="text-sm text-content-muted">{label}</dt>
      <dd className="text-lg tabular-nums text-content">{value}</dd>
    </div>
  );
}
