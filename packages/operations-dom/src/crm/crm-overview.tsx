import { hasFeature } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { keys, useOperations } from '../api.js';
import { cardClass, DashboardBackLink, Failure, Loading } from '../ui.js';

/**
 * The CRM's front page (CRM/ERP plan, phase F1).
 *
 * Reached from the CRM menu group, which only a company with the module and a
 * seat holding `crm.read` sees. Opened by address without either, it says so
 * rather than showing an empty page; the API refuses the data regardless.
 */
export function CrmOverviewScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });

  if (me.isPending) {
    return <Loading />;
  }
  if (me.isError) {
    return <Failure error={me.error} onRetry={() => void me.refetch()} />;
  }

  const enabled = hasFeature(me.data.features, 'crm');
  const allowed = me.data.permissions.includes('crm.read');

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
      ) : (
        <section aria-labelledby="crm-overview-sections" className={cardClass}>
          <h2 id="crm-overview-sections" className="text-base font-semibold text-content">
            {t('crm.overview.sections')}
          </h2>
          <ul className="flex flex-col gap-2">
            <li>
              <a
                href={paths.crmLeads}
                className="font-medium text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.crmLeads);
                }}
              >
                {t('crm.leads.title')}
              </a>
              <p className="text-sm text-content-muted">{t('nav.hint.leads')}</p>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
