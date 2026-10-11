import { hasFeature } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { keys, useOperations } from '../api.js';
import { cardClass, InlineError } from '../ui.js';
import { LeadStatusBadge } from './lead-parts.js';

/**
 * What the CRM knows about a customer, on the customer screen (CRM/ERP plan,
 * phase C2): the leads that became it. Shown only when the company has the
 * CRM and the seat may read it; otherwise the customer screen is exactly as it
 * was. Opportunities and follow-ups join it in phase C3.
 */
export function CustomerCrmSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
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

  return (
    <section aria-labelledby="customer-crm-heading" className={cardClass}>
      <h2 id="customer-crm-heading" className="text-lg font-semibold text-content">
        {t('crm.customer.heading')}
      </h2>
      {crm.isPending ? null : crm.isError ? (
        <InlineError onRetry={() => void crm.refetch()} />
      ) : crm.data.leads.length === 0 ? (
        <p className="text-sm text-content-muted">{t('crm.customer.noLeads')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {crm.data.leads.map((lead) => (
            <li key={lead.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <a
                href={paths.crmLead(lead.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.crmLead(lead.id));
                }}
              >
                {lead.displayName}
              </a>
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
    </section>
  );
}
