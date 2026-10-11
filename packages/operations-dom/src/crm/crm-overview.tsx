import { hasFeature, LEAD_STATUSES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { type CrmDashboard, keys, useOperations } from '../api.js';
import { cardClass, DashboardBackLink, Failure, InlineError, Loading } from '../ui.js';
import { formatAmount } from './lead-parts.js';
import { useStageName } from './opportunity-parts.js';

/**
 * The CRM's front page (CRM/ERP plan, phases F1 and C3): the dashboard.
 *
 * Reached from the CRM menu group, which only a company with the module and a
 * seat holding `crm.read` sees. Opened by address without either, it says so
 * rather than showing an empty page; the API refuses the data regardless.
 * Pipeline totals are estimates — a forecast, never revenue — and each
 * currency is totalled on its own.
 */
export function CrmOverviewScreen() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'crm');
  const allowed = me.data?.permissions.includes('crm.read') ?? false;
  const dashboard = useQuery({
    queryKey: keys.dashboard,
    queryFn: async () => (await client.GET('/v1/crm/dashboard')).data!,
    enabled: enabled && allowed,
  });

  if (me.isPending) {
    return <Loading />;
  }
  if (me.isError) {
    return <Failure error={me.error} onRetry={() => void me.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('crm.overview.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('crm.overview.intro')}</p>
      </header>

      {!enabled || !allowed ? (
        <p
          role="status"
          className="rounded-lg border border-border-subtle bg-surface-muted p-4 text-sm text-content"
        >
          {enabled ? t('errors.forbidden') : t('crm.overview.notEnabled')}
        </p>
      ) : dashboard.isPending ? (
        <Loading />
      ) : dashboard.isError ? (
        <InlineError onRetry={() => void dashboard.refetch()} />
      ) : (
        <Figures data={dashboard.data} />
      )}
    </div>
  );
}

function Figures({ data }: { data: CrmDashboard }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  const stageName = useStageName();
  const money = (totals: CrmDashboard['openTotals'], field: 'total' | 'weighted') =>
    totals.length === 0
      ? formatAmount('0', data.currency, locale)
      : totals.map((total) => formatAmount(total[field], total.currencyCode, locale)).join(' · ');

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title={t('crm.dashboard.openPipeline')}
          to={paths.crmOpportunities}
          value={money(data.openTotals, 'total')}
          note={t('crm.dashboard.openCount', {
            count: data.openTotals.reduce((sum, total) => sum + total.count, 0),
          })}
        />
        <Card
          title={t('crm.dashboard.weighted')}
          to={paths.crmOpportunities}
          value={money(data.openTotals, 'weighted')}
          note={t('crm.dashboard.forecastNote')}
        />
        <Card
          title={t('crm.dashboard.won')}
          to={paths.crmOpportunities}
          value={money(data.won, 'total')}
          note={t('crm.dashboard.wonLost', {
            won: data.won.reduce((sum, total) => sum + total.count, 0),
            lost: data.lostCount,
          })}
        />
        <Card
          title={t('crm.dashboard.followUps')}
          to={paths.crmActivities}
          value={t('crm.dashboard.overdueCount', { count: data.activities.overdue })}
          note={t('crm.dashboard.followUpsNote', {
            today: data.activities.dueToday,
            mine: data.activities.mine,
          })}
        />
      </div>

      <section aria-labelledby="crm-dashboard-stages" className={cardClass}>
        <h2 id="crm-dashboard-stages" className="text-base font-semibold text-content">
          {t('crm.dashboard.byStage')}
        </h2>
        <ul className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {data.pipeline.stages.map((stage) => (
            <li key={stage.id} className="flex flex-col gap-0.5">
              <span className="font-medium text-content">{stageName(stage)}</span>
              <span className="text-content-muted">
                {t('crm.opportunities.count', { count: stage.count })}
              </span>
              {stage.totals.map((total) => (
                <span key={total.currencyCode} className="text-content tabular-nums">
                  {formatAmount(total.total, total.currencyCode, locale)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="crm-dashboard-leads" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="crm-dashboard-leads" className="text-base font-semibold text-content">
            {t('crm.leads.title')}
          </h2>
          <AppLink to={paths.crmLeads}>{t('crm.dashboard.allLeads')}</AppLink>
        </div>
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {LEAD_STATUSES.map((status) => (
            <li key={status} className="flex flex-col">
              <span className="text-content-muted">{t(`crm.status.${status}`)}</span>
              <span className="text-lg font-semibold text-content tabular-nums">
                {data.leadsByStatus[status]}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Card({
  title,
  value,
  note,
  to,
}: {
  title: string;
  value: string;
  note: string;
  to: string;
}) {
  return (
    <section className={cardClass}>
      <h2 className="text-sm font-medium text-content-muted">
        <AppLink to={to}>{title}</AppLink>
      </h2>
      <p className="text-xl font-semibold break-words text-content tabular-nums">{value}</p>
      <p className="text-xs text-content-muted">{note}</p>
    </section>
  );
}

function AppLink({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
