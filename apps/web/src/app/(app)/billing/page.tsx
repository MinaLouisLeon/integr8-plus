'use client';

import { ApiRequestError } from '@integr8/api-client';
import { formatCurrency, formatDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorState, LoadingState } from '~/components/ui';
import { formatBytes } from '~/lib/platform-format';
import { planLabel } from '~/lib/plans';
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
 *
 * The invoices are listed here too (P18), read from the provider on each
 * visit rather than copied: an invoice is paid, voided or refunded over there,
 * and a copy here would be the one that was wrong. Each row opens the
 * provider's own hosted copy.
 */

type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

interface Invoice {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

async function fetchInvoices(): Promise<Invoice[]> {
  const { data } = await apiClient().GET('/v1/billing/invoices');
  return data?.items ?? [];
}

export default function BillingPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [problem, setProblem] = useState<string | null>(null);

  const subscription = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/billing/subscription');
      return data;
    },
  });

  const invoices = useQuery({ queryKey: ['billing', 'invoices'], queryFn: fetchInvoices });

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
  const day = (value: string | null) => (value === null ? '' : formatDate(value, { locale }));

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
            {t('workspace.billing.planNamed', { plan: planLabel(t, data.plan) })}
          </span>
          <span className="text-sm text-content-muted">
            {data.billingMode === 'invoiced'
              ? t('workspace.billing.invoiced')
              : t(`workspace.billing.status.${data.status}`)}
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
        {data.billingMode === 'invoiced' ? (
          <p className="text-sm text-content-muted">{t('workspace.billing.invoicedBody')}</p>
        ) : (
          <p className="text-sm text-content-muted">{t('workspace.billing.remindersInApp')}</p>
        )}
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

      {/*
        An invoiced company pays Integr8, not the provider: there are no
        provider invoices to list and no checkout or card portal to open, and
        the API refuses both (`billing_invoiced`). Hidden rather than disabled,
        because a disabled "pay" button on a paid-up account asks a question.
      */}
      {data.billingMode === 'invoiced' ? null : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-content">
              {t('workspace.billing.invoices')}
            </h2>
            <p className="text-sm text-content-muted">{t('workspace.billing.invoicesHint')}</p>
            {invoices.isPending ? (
              <LoadingState />
            ) : invoices.isError ? (
              <ErrorState
                requestId={
                  invoices.error instanceof ApiRequestError ? invoices.error.requestId : undefined
                }
                onRetry={() => void invoices.refetch()}
              />
            ) : invoices.data.length === 0 ? (
              <p className="text-sm text-content-muted">{t('workspace.billing.invoicesEmpty')}</p>
            ) : (
              <InvoiceTable invoices={invoices.data} locale={locale} />
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-content">
              {t('workspace.billing.manage')}
            </h2>
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
                  {planLabel(t, plan)}
                </Button>
              ))}
            </div>
          </section>
        </>
      )}
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

/**
 * The invoices, newest first, as the provider sent them.
 *
 * Money and dates go through `@integr8/i18n`, so `£49.00` and `1 October 2026`
 * follow the reader's locale rather than the server's — and so the currency
 * symbol is the invoice's own, never a default that happens to look right.
 */
function InvoiceTable({ invoices, locale }: { invoices: Invoice[]; locale: string }) {
  const { t } = useTranslation();

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-content-muted">
          <th className="py-1 text-start font-medium">{t('workspace.billing.invoiceNumber')}</th>
          <th className="py-1 text-start font-medium">{t('workspace.billing.invoiceDate')}</th>
          <th className="py-1 text-end font-medium">{t('workspace.billing.invoiceAmount')}</th>
          <th className="py-1 text-start font-medium ps-4">
            {t('workspace.billing.invoiceStatusLabel')}
          </th>
          <th className="py-1 text-end font-medium">
            <span className="sr-only">{t('workspace.billing.invoiceOpen')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((invoice) => {
          const label = invoice.number ?? t('workspace.billing.invoiceUnnumbered');
          return (
            <tr key={invoice.id} className="border-t border-border-subtle">
              <td className="py-2 text-content">
                {invoice.hostedUrl === null ? (
                  label
                ) : (
                  <a
                    href={invoice.hostedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    {label}
                  </a>
                )}
              </td>
              <td className="py-2 text-content-muted">
                {formatDate(invoice.createdAt, { locale })}
              </td>
              <td className="py-2 text-end tabular-nums text-content">
                {formatCurrency(invoice.amountDueCents / 100, invoice.currency, { locale })}
              </td>
              <td className="py-2 ps-4 text-content-muted">
                {t(`workspace.billing.invoiceStatus.${invoice.status}`)}
              </td>
              <td className="py-2 text-end">
                <span className="flex justify-end gap-3">
                  {invoice.hostedUrl === null ? null : (
                    <a
                      href={invoice.hostedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {t('workspace.billing.invoiceOpen')}
                    </a>
                  )}
                  {invoice.pdfUrl === null ? null : (
                    <a
                      href={invoice.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {t('workspace.billing.invoicePdf')}
                    </a>
                  )}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
