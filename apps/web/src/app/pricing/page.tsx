'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MarketingShell } from '~/components/marketing-shell';
import { ErrorState, LoadingState } from '~/components/ui';
import { formatBytes } from '~/lib/platform-format';
import { apiClient } from '~/lib/session';

/**
 * Pricing (P18).
 *
 * **Every number on this page is read from the API, not written in the copy.**
 * That is the exit criterion — *every plan limit shown on the pricing page
 * matches what the entitlement service enforces* — and reading
 * `plan_allowances` through `GET /v1/plans` is the only way to guarantee it.
 * Numbers typed into marketing copy are a second source of truth, and the two
 * disagree the first time somebody edits a plan from the dashboard.
 *
 * A plan with no price at the provider is shown as "talk to us" rather than
 * hidden or offered: hiding it makes the page lie about what exists, and
 * offering it sends somebody to a checkout that refuses them.
 */
export default function PricingPage() {
  const { t } = useTranslation();

  const plans = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/plans');
      return data;
    },
  });

  return (
    <MarketingShell step="pricing.viewed">
      <header className="flex flex-col gap-2 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-content">
          {t('marketing.pricing.title')}
        </h1>
        <p className="text-content-muted">{t('marketing.pricing.subtitle')}</p>
        <p className="text-sm text-content-muted">{t('marketing.pricing.honest')}</p>
      </header>

      {plans.isPending ? (
        <LoadingState />
      ) : plans.isError || plans.data === undefined ? (
        <ErrorState
          requestId={plans.error instanceof ApiRequestError ? plans.error.requestId : undefined}
          onRetry={() => void plans.refetch()}
        />
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {plans.data.items.map((plan) => (
            <article
              key={plan.plan}
              className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface p-6"
            >
              <h2 className="text-lg font-semibold capitalize text-content">{plan.plan}</h2>

              <p className="text-2xl font-bold text-content">
                {plan.priceCents === null ? (
                  t('marketing.pricing.free')
                ) : (
                  <>
                    {new Intl.NumberFormat('en-GB', {
                      style: 'currency',
                      currency: plan.currency ?? 'GBP',
                      maximumFractionDigits: 0,
                    }).format(plan.priceCents / 100)}
                    <span className="text-sm font-normal text-content-muted">
                      {' '}
                      {t('marketing.pricing.perMonth')}
                    </span>
                  </>
                )}
              </p>

              <ul className="flex flex-1 flex-col gap-1 text-sm text-content-muted">
                <li>
                  {plan.seats === null
                    ? t('marketing.pricing.seatsUncapped')
                    : t('marketing.pricing.seats', { count: plan.seats })}
                </li>
                <li>
                  {plan.submissionsPerMonth === null
                    ? t('marketing.pricing.submissionsUncapped')
                    : t('marketing.pricing.submissions', { count: plan.submissionsPerMonth })}
                </li>
                <li>
                  {plan.storageBytes === null
                    ? t('marketing.pricing.storageUncapped')
                    : t('marketing.pricing.storage', { amount: formatBytes(plan.storageBytes) })}
                </li>
                <li>
                  {plan.retentionDays === null
                    ? t('marketing.pricing.retentionForever')
                    : t('marketing.pricing.retention', { count: plan.retentionDays })}
                </li>
              </ul>

              {plan.purchasable ? (
                <Link
                  href="/sign-up"
                  className="inline-flex justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
                >
                  {t('marketing.pricing.choose', { plan: plan.plan })}
                </Link>
              ) : (
                // Not hidden and not offered. Hiding it would make the page lie
                // about what exists; offering it would send somebody to a
                // checkout that refuses them.
                <span className="text-sm text-content-muted">
                  {t('marketing.pricing.notPurchasable')}
                </span>
              )}
            </article>
          ))}
        </div>
      )}
    </MarketingShell>
  );
}
