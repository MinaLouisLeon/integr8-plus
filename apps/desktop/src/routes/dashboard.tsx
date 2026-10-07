import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { CompanyMark } from '~/components/company-brand';
import { Button, ErrorState, LoadingState, Shell } from '~/components/ui';
import { isTauri } from '~/lib/platform';
import { session } from '~/lib/session';

/**
 * The dashboard.
 *
 * Shows who is signed in and which company they are in, which is P05's first
 * exit criterion, and reports whether it is running as a Tauri window or a
 * browser tab — which is how the second criterion is checked by eye.
 */
export function DashboardRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/me');
      return data;
    },
  });

  if (me.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }

  if (me.isError) {
    return (
      <Shell>
        <ErrorState
          requestId={me.error instanceof ApiRequestError ? me.error.requestId : undefined}
          onRetry={() => void me.refetch()}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1 text-start">
          <h1 className="text-2xl font-semibold text-content">
            {t('workspace.signedInAs', { name: me.data?.displayName ?? '' })}
          </h1>
          {me.data === undefined ? null : <CompanyMark company={me.data.company} />}
        </div>

        <Button
          variant="secondary"
          onClick={() => {
            void (async () => {
              await session().signOut();
              void navigate('/sign-in', { replace: true });
            })();
          }}
        >
          {t('common.signOut')}
        </Button>
      </header>

      <nav aria-label={t('submissions.nav')} className="grid gap-4 sm:grid-cols-3">
        <Link
          to="/forms"
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
        >
          <span className="text-lg font-semibold text-content">{t('forms.nav.forms')}</span>
          <span className="text-sm text-content-muted">{t('forms.list.subtitle')}</span>
        </Link>
        <Link
          to="/fill"
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
        >
          <span className="text-lg font-semibold text-content">{t('submissions.fillNav')}</span>
          <span className="text-sm text-content-muted">{t('submissions.start.subtitle')}</span>
        </Link>
        <Link
          to="/submissions"
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
        >
          <span className="text-lg font-semibold text-content">{t('submissions.nav')}</span>
          <span className="text-sm text-content-muted">{t('submissions.list.title')}</span>
        </Link>
      </nav>

      <nav
        aria-label={t('operations.nav.label')}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {(
          [
            ['/work-orders', 'workOrders', 'workOrdersHint'],
            ['/customers', 'customers', 'customersHint'],
            ['/settings/job-types', 'jobTypes', 'jobTypesHint'],
            ['/imports', 'imports', 'importsHint'],
            // Everyone's time is the office's to read.
            ...(me.data?.permissions.includes('work_order.manage') === true
              ? ([['/timesheets', 'timesheets', 'timesheetsHint']] as const)
              : []),
          ] as const
        ).map(([to, label, hint]) => (
          <Link
            key={to}
            to={to}
            className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
          >
            <span className="text-lg font-semibold text-content">
              {t(`operations.nav.${label}`)}
            </span>
            <span className="text-sm text-content-muted">{t(`operations.nav.${hint}`)}</span>
          </Link>
        ))}
      </nav>

      <section className="rounded-lg border border-border-subtle bg-surface p-6 text-start">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-content-muted">
              {t('auth.email')}
            </dt>
            <dd className="text-sm text-content">{me.data?.email}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-content-muted">
              {t('common.runtime')}
            </dt>
            {/*
              A developer-facing diagnostic: it exists so P05's "identical in
              both" criterion can be checked by eye, and it goes once that has
              been signed off. Translated regardless — a string on screen is a
              string on screen, and the exception list is two error boundaries,
              not three.
            */}
            <dd className="text-sm text-content">{isTauri() ? 'Tauri window' : 'Browser tab'}</dd>
          </div>
        </dl>
      </section>
    </Shell>
  );
}
