import { hasFeature } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, cardClass, InlineError } from '../ui.js';
import { ActivityPanel } from './activities.js';
import { formatAmount, LeadStatusBadge } from './lead-parts.js';
import { NewOpportunityDialog, StageBadge } from './opportunity-parts.js';

/**
 * What the CRM knows about a customer, on the customer screen (CRM/ERP plan,
 * phases C2 and C3): its opportunities, follow-ups and the leads that became
 * it. Shown only when the company has the CRM and the seat may read it;
 * otherwise the customer screen is exactly as it was.
 */
export function CustomerCrmSection({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const [creating, setCreating] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const visible =
    hasFeature(me.data?.features, 'crm') && (me.data?.permissions.includes('crm.read') ?? false);
  const crm = useQuery({
    queryKey: keys.customerCrm(customerId),
    queryFn: async () =>
      (await client.GET('/v1/customers/{customerId}/crm', { params: { path: { customerId } } }))
        .data!,
    enabled: visible,
  });

  if (!visible) {
    return null;
  }

  const link = (href: string, label: string) => (
    <a
      href={href}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {label}
    </a>
  );

  return (
    <>
      <section aria-labelledby="customer-crm-heading" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="customer-crm-heading" className="text-lg font-semibold text-content">
            {t('crm.customer.heading')}
          </h2>
          {crm.data?.can.manageOpportunities === true ? (
            <button type="button" className={buttonClass.ghost} onClick={() => setCreating(true)}>
              {t('crm.opportunities.new')}
            </button>
          ) : null}
        </div>
        {crm.isPending ? null : crm.isError ? (
          <InlineError onRetry={() => void crm.refetch()} />
        ) : (
          <>
            <h3 className="text-sm font-semibold text-content">{t('crm.opportunities.title')}</h3>
            {crm.data.opportunities.length === 0 ? (
              <p className="text-sm text-content-muted">{t('crm.customer.noOpportunities')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {crm.data.opportunities.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    {link(paths.crmOpportunity(item.id), item.title)}
                    <span className="flex items-center gap-2 text-xs text-content-muted">
                      {item.amount === null
                        ? null
                        : formatAmount(item.amount, item.currencyCode, locale)}
                      <StageBadge stage={item.stage} status={item.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="text-sm font-semibold text-content">{t('crm.leads.title')}</h3>
            {crm.data.leads.length === 0 ? (
              <p className="text-sm text-content-muted">{t('crm.customer.noLeads')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {crm.data.leads.map((lead) => (
                  <li
                    key={lead.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    {link(paths.crmLead(lead.id), lead.displayName)}
                    <span className="flex items-center gap-2 text-xs text-content-muted">
                      <LeadStatusBadge status={lead.status} />
                      {lead.convertedAt === null
                        ? null
                        : t('crm.customer.convertedOn', {
                            date: formatDateTime(lead.convertedAt, { locale }),
                          })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      {crm.data === undefined ? null : (
        <ActivityPanel
          links={{ customerIds: [customerId] }}
          canManage={crm.data.can.manageActivities}
          heading={t('crm.customer.activities')}
        />
      )}
      {creating ? (
        <NewOpportunityDialog
          customer={{ id: customerId, name: customerName }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
