import { compareDecimals, isZeroDecimal } from '@integr8/core';
import { formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type PaymentDetail, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { isPositiveQuantity, QUANTITY_PATTERN } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';

/**
 * One payment received (CRM/ERP plan, phase B1; ADR-0007): what it was, the
 * invoices it is put against — removed allocations kept on record — what is
 * left on the customer's account, and putting that against another invoice.
 */
export function PaymentScreen({ paymentId }: { paymentId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');

  const detail = useQuery({
    queryKey: keys.payment(paymentId),
    queryFn: async () =>
      (
        await client.GET('/v1/finance/payments/{receiptId}', {
          params: { path: { receiptId: paymentId } },
        })
      ).data!,
  });
  const settle = async (next: PaymentDetail) => {
    queries.setQueryData(keys.payment(paymentId), next);
    await queries.invalidateQueries({ queryKey: ['finance'] });
  };
  const allocate = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/payments/{receiptId}/allocations', {
          params: { path: { receiptId: paymentId } },
          body: { invoiceId, amount: amount.trim() },
        })
      ).data!,
    onSuccess: async (next) => {
      setInvoiceId('');
      setAmount('');
      await settle(next);
    },
  });
  const remove = useMutation({
    mutationFn: async (allocationId: string) =>
      (
        await client.POST('/v1/finance/payments/{receiptId}/allocations/{allocationId}/remove', {
          params: { path: { receiptId: paymentId, allocationId } },
        })
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.payments} label={t('finance.payments.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { receipt, allocations, openInvoices, can } = detail.data;
  const money = (value: string) => formatAmount(value, receipt.currencyCode, locale);
  const chosen = openInvoices.find((invoice) => invoice.id === invoiceId);
  const suggested =
    chosen === undefined
      ? ''
      : compareDecimals(chosen.amounts.balance, receipt.unallocated) > 0
        ? receipt.unallocated
        : chosen.amounts.balance;
  const valid = chosen !== undefined && isPositiveQuantity(amount);
  const error = [allocate.error, remove.error].find((candidate) => candidate !== null);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content" dir="ltr">
          {receipt.reference}
        </h1>
        <p className="text-sm text-content-muted">
          <a
            href={paths.customer(receipt.customer.id)}
            className="text-accent underline-offset-4 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.customer(receipt.customer.id));
            }}
          >
            {receipt.customer.name}
          </a>
          {' · '}
          {t('finance.payments.recordedBy', {
            name: receipt.recordedBy.name,
            date: formatDateTime(receipt.recordedAt, { locale }),
          })}
        </p>
      </header>

      {error === undefined ? null : <Failure error={error} />}

      <section className={cardClass} aria-labelledby="finance-payment-facts">
        <h2 id="finance-payment-facts" className="sr-only">
          {t('finance.payments.details')}
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('finance.payments.amount')}</dt>
            <dd className="font-semibold text-content tabular-nums">{money(receipt.amount)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('finance.payments.allocated')}</dt>
            <dd className="text-content tabular-nums">{money(receipt.allocated)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('finance.payments.unallocated')}</dt>
            <dd className="text-content tabular-nums">{money(receipt.unallocated)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('finance.payments.receivedOn')}</dt>
            <dd className="text-content">{formatDate(receipt.receivedOn, { locale })}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('finance.payments.method')}</dt>
            <dd className="text-content">{t(`finance.method.${receipt.method}`)}</dd>
          </div>
          {receipt.paymentReference === null ? null : (
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('finance.payments.reference')}</dt>
              <dd className="text-content" dir="auto">
                {receipt.paymentReference}
              </dd>
            </div>
          )}
          {receipt.notes === null ? null : (
            <div className="col-span-full flex flex-col">
              <dt className="text-content-muted">{t('finance.payments.notes')}</dt>
              <dd className="whitespace-pre-wrap text-content" dir="auto">
                {receipt.notes}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="finance-payment-allocations">
        <h2 id="finance-payment-allocations" className="text-lg font-semibold text-content">
          {t('finance.payments.allocations')}
        </h2>
        {allocations.length === 0 ? (
          <p className="text-sm text-content-muted">{t('finance.payments.noAllocations')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {allocations.map((allocation) => {
              const removed = allocation.removedAt !== null;
              return (
                <li
                  key={allocation.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <a
                      href={paths.invoice(allocation.invoice.id)}
                      dir="ltr"
                      className={`self-start font-medium text-accent underline-offset-4 hover:underline ${removed ? 'line-through' : ''}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.invoice(allocation.invoice.id));
                      }}
                    >
                      {allocation.invoice.reference ?? t('finance.invoices.draftLabel')}
                    </a>
                    <span className="text-content-muted">
                      {removed
                        ? t('finance.payments.removedLine', {
                            name: allocation.removedBy?.name ?? '',
                            date: formatDateTime(allocation.removedAt!, { locale }),
                          })
                        : t('finance.payments.allocatedLine', {
                            name: allocation.allocatedBy.name,
                            date: formatDateTime(allocation.allocatedAt, { locale }),
                          })}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`tabular-nums ${removed ? 'text-content-muted line-through' : 'text-content'}`}
                    >
                      {money(allocation.amount)}
                    </span>
                    {can.removeAllocation && !removed ? (
                      <button
                        type="button"
                        className={buttonClass.secondary}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t('finance.payments.removeConfirm'))) {
                            remove.mutate(allocation.id);
                          }
                        }}
                      >
                        {t('finance.payments.remove')}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {can.allocate ? (
        <section className={cardClass} aria-labelledby="finance-payment-allocate">
          <h2 id="finance-payment-allocate" className="mb-3 text-lg font-semibold text-content">
            {t('finance.payments.allocateTitle')}
          </h2>
          {openInvoices.length === 0 ? (
            <p className="text-sm text-content-muted">{t('finance.payments.noOpenInvoices')}</p>
          ) : (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (valid) {
                  allocate.mutate();
                }
              }}
            >
              <Field label={t('finance.payments.invoice')} className="min-w-64 flex-1">
                {(id) => (
                  <select
                    id={id}
                    required
                    className={inputClass}
                    value={invoiceId}
                    onChange={(event) => {
                      setInvoiceId(event.target.value);
                      const next = openInvoices.find(
                        (invoice) => invoice.id === event.target.value,
                      );
                      setAmount(
                        next === undefined
                          ? ''
                          : compareDecimals(next.amounts.balance, receipt.unallocated) > 0
                            ? receipt.unallocated
                            : next.amounts.balance,
                      );
                    }}
                  >
                    <option value="">{t('finance.payments.chooseInvoice')}</option>
                    {openInvoices.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {t('finance.payments.invoiceOption', {
                          reference: invoice.reference ?? '',
                          balance: money(invoice.amounts.balance),
                        })}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label={t('finance.payments.amount')}
                {...(suggested === '' || isZeroDecimal(suggested)
                  ? {}
                  : { hint: t('finance.payments.upTo', { amount: money(suggested) }) })}
              >
                {(id, describedBy) => (
                  <input
                    id={id}
                    required
                    inputMode="decimal"
                    dir="ltr"
                    aria-describedby={describedBy}
                    pattern={QUANTITY_PATTERN}
                    className={inputClass}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.trim())}
                  />
                )}
              </Field>
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={!valid || allocate.isPending}
              >
                {allocate.isPending ? t('finance.saving') : t('finance.payments.allocate')}
              </button>
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
