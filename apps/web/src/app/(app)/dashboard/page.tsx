'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { CompanyMark } from '~/components/company-brand';
import { ErrorState, LoadingState } from '~/components/ui';
import { apiClient } from '~/lib/session';

/**
 * The dashboard.
 *
 * It shows who is signed in and which company they are in, which is P05's first
 * exit criterion. Everything else is P06 onward; what this proves is that the
 * whole chain works — cookie, refresh, generated client, tenant-scoped API,
 * translated copy, mirrored layout.
 */
export default function DashboardPage() {
  const { t } = useTranslation();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/me');
      return data;
    },
  });

  if (me.isPending) {
    return <LoadingState />;
  }

  if (me.isError) {
    const failure = me.error;
    return (
      <ErrorState
        requestId={failure instanceof ApiRequestError ? failure.requestId : undefined}
        onRetry={() => void me.refetch()}
      />
    );
  }

  const person = me.data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1 text-start">
        <h1 className="text-2xl font-semibold text-content">
          {t('workspace.signedInAs', { name: person?.displayName ?? '' })}
        </h1>
        {person === undefined ? null : <CompanyMark company={person.company} />}
      </header>

      <nav aria-label={t('submissions.nav')} className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/fill"
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
        >
          <span className="text-lg font-semibold text-content">{t('submissions.fillNav')}</span>
          <span className="text-sm text-content-muted">{t('submissions.start.subtitle')}</span>
        </Link>
        <Link
          href="/submissions"
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
        >
          <span className="text-lg font-semibold text-content">{t('submissions.nav')}</span>
          <span className="text-sm text-content-muted">{t('submissions.list.title')}</span>
        </Link>
      </nav>

      <nav aria-label={t('operations.nav.label')} className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ['/work-orders', 'workOrders', 'workOrdersHint'],
            ['/customers', 'customers', 'customersHint'],
            ['/settings/job-types', 'jobTypes', 'jobTypesHint'],
            ['/imports', 'imports', 'importsHint'],
            // Everyone's time is the office's to read.
            ...(person?.permissions.includes('work_order.manage') === true
              ? ([['/timesheets', 'timesheets', 'timesheetsHint']] as const)
              : []),
            // What the company is using, and how close to the limit (P16).
            ...(person?.permissions.includes('storage.read') === true
              ? ([['/storage', 'storage', 'storageHint']] as const)
              : []),
            // The plan, the limits and the card (P17). Shown to anybody who may
            // read billing, which is owners and admins; only an owner can act.
            ...(person?.permissions.includes('billing.read') === true
              ? ([['/billing', 'billing', 'billingHint']] as const)
              : []),
            // Getting set up, and the people already here (P18).
            ['/get-started', 'getStarted', 'getStartedHint'] as const,
            ...(person?.permissions.includes('member.read') === true
              ? ([['/settings/people', 'people', 'peopleHint']] as const)
              : []),
            ...(person?.permissions.includes('tenant.update') === true
              ? ([['/settings/company', 'companySettings', 'companySettingsHint']] as const)
              : []),
          ] as const
        ).map(([href, label, hint]) => (
          <Link
            key={href}
            href={href}
            className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
          >
            <span className="text-lg font-semibold text-content">
              {t(`operations.nav.${label}`)}
            </span>
            <span className="text-sm text-content-muted">{t(`operations.nav.${hint}`)}</span>
          </Link>
        ))}
      </nav>

      <section className="rounded-lg border border-border-subtle bg-surface p-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1 text-start">
            <dt className="text-xs uppercase tracking-wide text-content-muted">
              {t('auth.email')}
            </dt>
            <dd className="text-sm text-content">{person?.email}</dd>
          </div>
          <div className="flex flex-col gap-1 text-start">
            <dt className="text-xs uppercase tracking-wide text-content-muted">
              {t('workspace.roleLabel')}
            </dt>
            <dd className="text-sm text-content">{person?.role}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
