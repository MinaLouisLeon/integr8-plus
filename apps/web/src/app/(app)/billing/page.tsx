'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorState, LoadingState } from '~/components/ui';
import { formatBytes } from '~/lib/platform-format';
import { apiClient } from '~/lib/session';

/**
 * What this company pays, and how to fix it when it stops (P17).
 *
 * The screen a company in arrears is sent to, so two things matter more than
 * looks. **It keeps working when everything else does not** — the two buttons
 * on it are the only writes a read-only company may still make, because a
 * company that cannot reach the checkout cannot stop being read-only. And **it
 * says what is actually happening**, including the part we would rather not
 * advertise: reminders are in-app only, so this page is the only place a failed
 * payment is announced.
 *
 * No card number is typed here, ever. Both buttons hand the browser to the
 * provider's own hosted page and come back; nothing in this app sees a card,
 * which is the whole reason it is done this way.
 */
export default function BillingPage() {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<string | null>(null);

  const subscription = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/billing/subscription');
      return data;
    },
  });

  /**
   * Sends the browser to the provider.
   *
   * `window.location` rather than a new tab: a popup blocker silently eating
   * the checkout is indistinguishable, to the person, from the button being
   * broken.
   */
  const leave = (url: string) => {
    window.location.href = url;
  };

  const portal = useMutation({
    // The client throws an `ApiRequestError` on any failure response, so there
    // is nothing to check here: a refusal arrives in `onError`.
    mutationFn: async () => {
      const { data } = await apiClient().POST('/v1/billing/portal', {});
      return data;
    },
    onSuccess: (data) => {
      if (data !== undefined) {
        leave(data.url);
      }
    },
    onError: () => {
      setProblem(t('workspace.billing.noAccount'));
    },
  });

  const checkout = useMutation({
    mutationFn: async (plan: 'starter' | 'standard' | 'enterprise') => {
      const { data } = await apiClient().POST('/v1/billing/checkout', {
        body: { plan, interval: 'month' },
      });
      return data;
    },
    onSuccess: (data) => {
      if (data !== undefined) {
        leave(data.url);
      }
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiRequestError && error.status === 503
          ? t('workspace.billing.notConfigured')
          : t('workspace.billing.notPurchasable'),
      );
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
  const day = (value: string | null) =>
    value === null ? '' : new Date(value).toLocaleDateString();

  return (
    <main className="flex flex-col gap-6">
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
      ) : data.status === 'past_due' ? (
        <p
          role="status"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm font-medium text-warning"
        >
          {data.graceEndsAt === null
            ? t('workspace.billing.pastDue')
            : t('workspace.billing.pastDueDeadline', { when: day(data.graceEndsAt) })}
        </p>
      ) : null}

      {problem === null ? null : (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {problem}
        </p>
      )}

      <section className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-lg font-semibold text-content">
            {t('workspace.billing.plan')}: {data.plan}
          </span>
          <span className="text-sm text-content-muted">
            {t(`workspace.billing.status.${data.status}`)}
          </span>
        </div>

        {data.status === 'trialing' && data.trialEndsAt !== null ? (
          <p className="text-sm text-content-muted">
            {t('workspace.billing.trialEnds', { when: day(data.trialEndsAt) })}
          </p>
        ) : null}

        {data.cancelAtPeriodEnd && data.currentPeriodEnd !== null ? (
          <p className="text-sm text-content-muted">
            {t('workspace.billing.cancelling', { when: day(data.currentPeriodEnd) })}
          </p>
        ) : data.currentPeriodEnd !== null ? (
          <p className="text-sm text-content-muted">
            {t('workspace.billing.renews', { when: day(data.currentPeriodEnd) })}
          </p>
        ) : null}

        {/*
          Said on the screen, not only in a document. Somebody whose card has
          expired has no other way of learning that we will never email them.
        */}
        <p className="text-sm text-content-muted">{t('workspace.billing.remindersInApp')}</p>
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

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-content">{t('workspace.billing.manage')}</h2>
        <p className="text-sm text-content-muted">{t('workspace.billing.manageHint')}</p>
        <div className="flex flex-wrap gap-3">
          <Button
            busy={portal.isPending}
            onClick={() => {
              setProblem(null);
              portal.mutate();
            }}
          >
            {portal.isPending ? t('workspace.billing.opening') : t('workspace.billing.manage')}
          </Button>

          {(['starter', 'standard', 'enterprise'] as const).map((plan) => (
            <Button
              key={plan}
              variant="secondary"
              busy={checkout.isPending}
              onClick={() => {
                setProblem(null);
                checkout.mutate(plan);
              }}
            >
              {plan}
            </Button>
          ))}
        </div>
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
