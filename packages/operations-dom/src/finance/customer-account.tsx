import { isZeroDecimal } from '@integr8/core';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { buttonClass, cardClass, InlineError } from '../ui.js';
import { InvoiceStatusBadge, RecordPaymentDialog, useFinanceAccess } from './finance-parts.js';
import { NewInvoiceDialog } from './invoice-list.js';

/**
 * The customer's account, on the customer screen (CRM/ERP plan, phase B1):
 * per currency what issued invoices still owe and what payments have left on
 * account, the invoices that owe and the payments with money left. Shown only
 * when the company has the finance module and the seat may read it.
 */
export function CustomerAccountSection({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const access = useFinanceAccess();
  const [dialog, setDialog] = useState<'invoice' | 'payment' | null>(null);
  const account = useQuery({
    queryKey: keys.customerAccount(customerId),
    queryFn: async () =>
      (
        await client.GET('/v1/finance/customers/{customerId}/account', {
          params: { path: { customerId } },
        })
      ).data!,
    enabled: access.read,
  });

  if (!access.read) {
    return null;
  }
  const customer = { id: customerId, name: customerName };
  const link = (href: string, label: string) => (
    <a
      href={href}
      dir="ltr"
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
    <section
      aria-labelledby="customer-account-heading"
      className={`${cardClass} flex flex-col gap-3`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="customer-account-heading" className="text-lg font-semibold text-content">
          {t('finance.account.heading')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {access.manage ? (
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => setDialog('invoice')}
            >
              {t('finance.invoices.new')}
            </button>
          ) : null}
          {access.issue ? (
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => setDialog('payment')}
            >
              {t('finance.payments.record')}
            </button>
          ) : null}
        </div>
      </div>
      {account.isPending ? null : account.isError ? (
        <InlineError onRetry={() => void account.refetch()} />
      ) : (
        <>
          {account.data.accounts.length === 0 ? (
            <p className="text-sm text-content-muted">{t('finance.account.nothing')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {account.data.accounts.map((row) => (
                <li key={row.currencyCode} className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                  <span className="text-content">
                    {t('finance.account.owed', {
                      amount: formatAmount(row.owed, row.currencyCode, locale),
                    })}
                  </span>
                  {isZeroDecimal(row.unallocated) ? null : (
                    <span className="text-content-muted">
                      {t('finance.account.onAccount', {
                        amount: formatAmount(row.unallocated, row.currencyCode, locale),
                      })}
                    </span>
                  )}
                  <span className="font-semibold text-content">
                    {row.net.startsWith('-')
                      ? t('finance.account.inCredit', {
                          amount: formatAmount(row.net.replace(/^-/, ''), row.currencyCode, locale),
                        })
                      : t('finance.account.net', {
                          amount: formatAmount(row.net, row.currencyCode, locale),
                        })}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="text-sm font-semibold text-content">
            {t('finance.account.openInvoices')}
          </h3>
          {account.data.openInvoices.length === 0 ? (
            <p className="text-sm text-content-muted">{t('finance.account.noOpenInvoices')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {account.data.openInvoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {link(paths.invoice(invoice.id), invoice.reference ?? '')}
                    <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
                  </span>
                  <span className="flex items-center gap-3 text-content-muted tabular-nums">
                    {invoice.dueDate === null
                      ? null
                      : t('finance.invoices.dueOn', {
                          date: formatDate(invoice.dueDate, { locale }),
                        })}
                    <span className="text-content">
                      {t('finance.invoices.owes', {
                        amount: formatAmount(invoice.amounts.balance, invoice.currencyCode, locale),
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {account.data.unallocatedPayments.length === 0 ? null : (
            <>
              <h3 className="text-sm font-semibold text-content">
                {t('finance.account.unallocatedPayments')}
              </h3>
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {account.data.unallocatedPayments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      {link(paths.payment(payment.id), payment.reference)}
                      <span className="text-content-muted">
                        {formatDate(payment.receivedOn, { locale })}
                      </span>
                    </span>
                    <span className="text-content tabular-nums">
                      {t('finance.payments.onAccount', {
                        amount: formatAmount(payment.unallocated, payment.currencyCode, locale),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {dialog === 'invoice' ? (
        <NewInvoiceDialog customer={customer} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'payment' ? (
        <RecordPaymentDialog customer={customer} onClose={() => setDialog(null)} />
      ) : null}
    </section>
  );
}
