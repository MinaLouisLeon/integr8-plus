import { formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keys, useOperations, type WorkOrderState } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { buttonClass, cardClass, Failure, InlineError } from '../ui.js';
import { InvoiceStatusBadge, PartsNotYetBilledBadge, useFinanceAccess } from './finance-parts.js';

/**
 * Money on the job screen (CRM/ERP plan, phase B1; ADR-0007): the job's
 * invoices, drafting one once the job is complete, and what the job cost —
 * parts at their cost, labour at the company's hourly cost when set —
 * against what it earned. An estimate for the office, not an accounting
 * entry; costs and profit are shown only to the seats that may see costs.
 */
export function JobFinancePanel({
  workOrderId,
  state,
}: {
  workOrderId: string;
  state: WorkOrderState;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useFinanceAccess();
  const costs = useQuery({
    queryKey: keys.jobCosts(workOrderId),
    queryFn: async () =>
      (
        await client.GET('/v1/finance/work-orders/{workOrderId}/costs', {
          params: { path: { workOrderId } },
        })
      ).data!,
    enabled: access.read,
  });
  const invoiceQuery = { workOrderId, limit: 20 };
  const invoices = useQuery({
    queryKey: keys.invoices(invoiceQuery),
    queryFn: async () =>
      (await client.GET('/v1/finance/invoices', { params: { query: invoiceQuery } })).data!,
    enabled: access.read,
  });
  const create = useMutation({
    mutationFn: async () =>
      (await client.POST('/v1/finance/invoices/from-job', { body: { workOrderId } })).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['finance'] });
      navigate(paths.invoice(created.invoice.id));
    },
  });

  if (!access.read) {
    return null;
  }
  const billed = (invoices.data?.items ?? []).filter((invoice) => invoice.status !== 'void');
  const complete = state === 'complete' || state === 'reviewed';
  // Parts synced from a phone after the job was invoiced: drafting from the job
  // again bills just those (0062).
  const followUp = billed.some((invoice) => invoice.partsNotYetBilled);

  return (
    <section aria-labelledby="job-finance-heading" className={`${cardClass} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="job-finance-heading" className="text-lg font-semibold text-content">
          {t('finance.job.heading')}
        </h2>
        {access.manage && complete && invoices.isSuccess && (billed.length === 0 || followUp) ? (
          <button
            type="button"
            className={buttonClass.primary}
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending
              ? t('finance.invoices.creating')
              : followUp
                ? t('finance.job.invoiceFollowUp')
                : t('finance.job.invoice')}
          </button>
        ) : null}
      </div>
      {create.isError ? <Failure error={create.error} /> : null}
      {followUp ? (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-content"
        >
          {t('finance.job.partsNotYetBilledHint')}
        </p>
      ) : null}

      {invoices.isError ? (
        <InlineError onRetry={() => void invoices.refetch()} />
      ) : invoices.isPending ? null : billed.length === 0 ? (
        <p className="text-sm text-content-muted">
          {complete ? t('finance.job.notInvoiced') : t('finance.job.notComplete')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {billed.map((invoice) => (
            <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <a
                  href={paths.invoice(invoice.id)}
                  dir="ltr"
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.invoice(invoice.id));
                  }}
                >
                  {invoice.reference ?? t('finance.invoices.draftLabel')}
                </a>
                <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
                {invoice.partsNotYetBilled ? <PartsNotYetBilledBadge /> : null}
              </span>
              <span className="text-content tabular-nums">
                {formatAmount(invoice.amounts.total, invoice.currencyCode, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {costs.isError ? (
        <InlineError onRetry={() => void costs.refetch()} />
      ) : costs.isPending ? null : (
        <>
          <h3 className="text-sm font-semibold text-content">{t('finance.job.costsHeading')}</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('finance.job.hours')}</dt>
              <dd className="text-content tabular-nums">
                {formatNumber(Number(costs.data.labour.hours), { locale })}
              </dd>
            </div>
            {costs.data.seesCosts ? (
              <>
                <div className="flex flex-col">
                  <dt className="text-content-muted">{t('finance.job.parts')}</dt>
                  <dd className="text-content tabular-nums">
                    {formatAmount(costs.data.parts.cost ?? '0', costs.data.currencyCode, locale)}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-content-muted">{t('finance.job.labour')}</dt>
                  <dd className="text-content tabular-nums">
                    {costs.data.labour.costed && costs.data.labour.cost !== null
                      ? formatAmount(costs.data.labour.cost, costs.data.currencyCode, locale)
                      : t('finance.job.labourNotCosted')}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-content-muted">{t('finance.job.cost')}</dt>
                  <dd className="text-content tabular-nums">
                    {formatAmount(costs.data.cost ?? '0', costs.data.currencyCode, locale)}
                  </dd>
                </div>
              </>
            ) : null}
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('finance.job.invoiced')}</dt>
              <dd className="text-content tabular-nums">
                {formatAmount(costs.data.invoiced.net, costs.data.currencyCode, locale)}
              </dd>
            </div>
            {costs.data.seesCosts && costs.data.profit !== null ? (
              <div className="flex flex-col">
                <dt className="text-content-muted">{t('finance.job.profit')}</dt>
                <dd className="font-semibold text-content tabular-nums">
                  {formatAmount(costs.data.profit, costs.data.currencyCode, locale)}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="text-xs text-content-muted">
            {costs.data.seesCosts && !costs.data.labour.costed
              ? t('finance.job.partsOnly')
              : t('finance.job.estimate')}
          </p>
        </>
      )}
    </section>
  );
}
