'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { Badge, Panel } from '~/components/platform-bits';
import { ErrorState, LoadingState } from '~/components/ui';
import { formatDate, formatDuration } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * Where people give up (P18).
 *
 * The visible half of the fourth exit criterion. Each row shows how many
 * reached that step and what share of the previous step that is, because the
 * absolute number answers "how are we doing" and the ratio answers "where is
 * the problem", and only the second one tells you what to fix.
 *
 * The note under the table is not decoration. The page steps count *visits* and
 * the rest count *attempts*, because before somebody submits the form there is
 * nothing to identify an attempt by and nothing should be invented. Presenting
 * the two as one series without saying so would overstate the top of the funnel
 * and make every drop below it look worse than it is.
 *
 * Under the table: **landing to first form**, the second exit criterion, as a
 * median over the companies created in the window. The API measures it from
 * the company coming to exist, and the panel says so, because the page views
 * before that cannot be tied to a company without inventing an identity.
 */

/** The order steps happen in. Anything unrecognised is listed after, as-is. */
const ORDER = [
  'landing.viewed',
  'features.viewed',
  'pricing.viewed',
  'signup.opened',
  'signup.started',
  'signup.email_sent',
  'signup.verified',
  'signup.provisioned',
] as const;

export default function FunnelPage() {
  const { t } = useTranslation();

  const funnel = useQuery({
    queryKey: ['platform', 'funnel'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/funnel', {
        params: { query: { days: 30 } },
      });
      return data;
    },
  });

  if (funnel.isPending) {
    return <LoadingState />;
  }

  if (funnel.isError || funnel.data === undefined) {
    return (
      <ErrorState
        requestId={funnel.error instanceof ApiRequestError ? funnel.error.requestId : undefined}
        onRetry={() => void funnel.refetch()}
      />
    );
  }

  const counts = new Map(funnel.data.steps.map((step) => [step.step, step.count]));
  const known = ORDER.map((step) => ({ step, count: counts.get(step) ?? 0 }));
  const extra = funnel.data.steps
    .filter((step) => !ORDER.includes(step.step as (typeof ORDER)[number]))
    .map((step) => ({ step: step.step, count: step.count }));
  const rows = [...known, ...extra];

  const timing = funnel.data.timeToFirstForm;

  const label = (step: string) => {
    const key = `platform.funnel.steps.${step}`;
    const translated = t(key as 'platform.funnel.steps.signup.started');
    // An unrecognised step still appears, under its raw key. The alternative
    // is a funnel that silently omits whatever was added most recently.
    return translated === key ? step : translated;
  };

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.funnel.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.funnel.subtitle')}</p>
      </header>

      <Panel title={t('platform.funnel.title')}>
        {rows.every((row) => row.count === 0) ? (
          <p className="text-sm text-content-muted">{t('platform.funnel.empty')}</p>
        ) : (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-start text-content-muted">
                  <th className="py-1 text-start">{t('platform.funnel.step')}</th>
                  <th className="py-1 text-end">{t('platform.funnel.reached')}</th>
                  <th className="py-1 text-end">{t('platform.funnel.ofPrevious')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const previous = index === 0 ? null : (rows[index - 1]?.count ?? 0);
                  const share =
                    previous === null || previous === 0
                      ? null
                      : Math.round((row.count / previous) * 100);

                  return (
                    <tr key={row.step} className="border-b border-border-subtle">
                      <td className="py-1">{label(row.step)}</td>
                      <td className="py-1 text-end tabular-nums">{row.count}</td>
                      <td className="py-1 text-end tabular-nums">
                        {share === null ? '—' : `${String(share)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-4 text-xs text-content-muted">{t('platform.funnel.visitsNote')}</p>
          </>
        )}
      </Panel>

      <Panel
        title={t('platform.funnel.timeToFirstForm')}
        description={t('platform.funnel.timeToFirstFormHint')}
      >
        {timing === undefined || timing.companies === 0 || timing.medianSeconds === null ? (
          <p className="text-sm text-content-muted">{t('platform.funnel.timeToFirstFormEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-3xl font-semibold tabular-nums text-content">
              {formatDuration(timing.medianSeconds) ?? '—'}
            </p>
            <p className="text-sm text-content-muted">
              {t('platform.funnel.timeToFirstFormCompanies', { count: timing.companies })}{' '}
              {t('platform.funnel.timeToFirstFormTarget')}
            </p>
          </div>
        )}
      </Panel>

      <Panel title={t('platform.funnel.signups')}>
        {funnel.data.signups.length === 0 ? (
          <p className="text-sm text-content-muted">{t('platform.funnel.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {funnel.data.signups.map((signup) => (
              <li key={signup.id} className="flex flex-wrap items-center gap-3">
                <span className="text-content">{signup.companyName}</span>
                <span className="text-content-muted">{signup.email}</span>
                <Badge
                  tone={
                    signup.status === 'verified'
                      ? 'muted'
                      : signup.status === 'pending'
                        ? 'warning'
                        : 'muted'
                  }
                >
                  {signup.status}
                </Badge>
                <span className="ms-auto text-content-muted">{formatDate(signup.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}
