import { compareDecimals, hasFeature, PAYMENT_METHODS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type InvoiceStatus,
  keys,
  type PaymentDetail,
  type PaymentMethod,
  useOperations,
} from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import {
  isPositiveQuantity,
  QUANTITY_PATTERN,
  useIdempotencyKey,
} from '../purchasing/purchasing-parts.js';
import { buttonClass, Dialog, Failure, Field, inputClass } from '../ui.js';

/**
 * Pieces the finance screens share (CRM/ERP plan, phase B1; ADR-0007): who
 * may do what, the invoice status badge, the amounts an invoice adds up to,
 * and recording a payment — from the payments list, an invoice or a
 * customer.
 */

/** What this seat may do with the company's finance module. */
export function useFinanceAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'finance');
  return {
    loaded: me.data !== undefined,
    enabled,
    read: enabled && permissions.includes('finance.read'),
    manage: enabled && permissions.includes('finance.manage'),
    issue: enabled && permissions.includes('finance.issue'),
  };
}

const STATUS_STYLE: Record<InvoiceStatus, string> = {
  draft: 'border-border-subtle bg-surface-muted text-content',
  issued: 'border-accent bg-surface text-content',
  partially_paid: 'border-accent bg-surface text-content',
  paid: 'border-success text-content',
  credited: 'border-border-subtle bg-surface-muted text-content-muted',
  void: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

export function InvoiceStatusBadge({
  status,
  overdue,
}: {
  status: InvoiceStatus;
  overdue: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
      >
        {t(`finance.status.${status}`)}
      </span>
      {overdue ? (
        <span className="inline-flex items-center rounded-full border border-danger px-2 py-0.5 text-xs font-medium text-danger">
          {t('finance.overdue')}
        </span>
      ) : null}
    </span>
  );
}

/** What an invoice adds up to and what is left, as a definition list. */
export function AmountsSummary({
  amounts,
  currency,
}: {
  amounts: { total: string; allocated: string; credited: string; balance: string };
  currency: string;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const money = (value: string) => formatAmount(value, currency, locale);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      <div className="flex flex-col">
        <dt className="text-content-muted">{t('finance.amounts.total')}</dt>
        <dd className="text-content tabular-nums">{money(amounts.total)}</dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-content-muted">{t('finance.amounts.credited')}</dt>
        <dd className="text-content tabular-nums">{money(amounts.credited)}</dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-content-muted">{t('finance.amounts.paid')}</dt>
        <dd className="text-content tabular-nums">{money(amounts.allocated)}</dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-content-muted">{t('finance.amounts.balance')}</dt>
        <dd className="font-semibold text-content tabular-nums">{money(amounts.balance)}</dd>
      </div>
    </dl>
  );
}

/** Today in this device's calendar, as `YYYY-MM-DD`. */
export function todayInput(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Records a payment received from a customer. From an invoice, it is put
 * against that invoice — as much as the invoice owes — and the rest stays
 * on the customer's account.
 */
export function RecordPaymentDialog({
  customer,
  invoice,
  onClose,
  onDone,
}: {
  /** Absent from the payments list: the dialog asks for the customer. */
  customer?: { id: string; name: string };
  invoice?: { id: string; reference: string | null; balance: string; currencyCode: string };
  onClose: () => void;
  onDone?: (payment: PaymentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const queries = useQueryClient();
  const [chosen, setChosen] = useState(customer ?? null);
  const [amount, setAmount] = useState(invoice?.balance ?? '');
  const [receivedOn, setReceivedOn] = useState(todayInput());
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const valid = chosen !== null && isPositiveQuantity(amount) && receivedOn !== '';
  const allocation =
    invoice === undefined || !valid
      ? undefined
      : {
          invoiceId: invoice.id,
          amount: compareDecimals(amount, invoice.balance) > 0 ? invoice.balance : amount,
        };
  const body = {
    customerId: chosen?.id ?? '',
    receivedOn,
    amount: amount.trim(),
    ...(invoice === undefined ? {} : { currencyCode: invoice.currencyCode }),
    method,
    ...(reference.trim() === '' ? {} : { paymentReference: reference.trim() }),
    ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
    allocations: allocation === undefined ? [] : [allocation],
  };
  const idempotencyKey = useIdempotencyKey(body);
  const record = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/payments', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: async (payment) => {
      await queries.invalidateQueries({ queryKey: ['finance'] });
      if (onDone === undefined) {
        navigate(paths.payment(payment.receipt.id));
      } else {
        onDone(payment);
      }
    },
  });

  return (
    <Dialog
      title={t('finance.payments.record')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('finance.cancel')}
          </button>
          <button
            type="submit"
            form="finance-record-payment"
            className={buttonClass.primary}
            disabled={!valid || record.isPending}
          >
            {record.isPending
              ? t('finance.payments.recording')
              : t('finance.payments.recordAction')}
          </button>
        </>
      }
    >
      <form
        id="finance-record-payment"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            record.mutate();
          }
        }}
      >
        {customer === undefined ? (
          <CustomerPicker label={t('finance.customer')} value={chosen} onChange={setChosen} />
        ) : (
          <p className="text-sm text-content">
            <span className="text-content-muted">{t('finance.customer')}: </span>
            {customer.name}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('finance.payments.amount')}>
            {(id) => (
              <input
                id={id}
                required
                inputMode="decimal"
                dir="ltr"
                pattern={QUANTITY_PATTERN}
                className={inputClass}
                value={amount}
                onChange={(event) => setAmount(event.target.value.trim())}
              />
            )}
          </Field>
          <Field label={t('finance.payments.receivedOn')}>
            {(id) => (
              <input
                id={id}
                type="date"
                dir="ltr"
                required
                max={todayInput()}
                className={inputClass}
                value={receivedOn}
                onChange={(event) => setReceivedOn(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('finance.payments.method')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={method}
                onChange={(event) => setMethod(event.target.value as PaymentMethod)}
              >
                {PAYMENT_METHODS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {t(`finance.method.${candidate}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('finance.payments.reference')} hint={t('finance.payments.referenceHint')}>
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                maxLength={200}
                dir="auto"
                className={inputClass}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label={t('finance.payments.notes')}>
          {(id) => (
            <textarea
              id={id}
              rows={2}
              maxLength={2000}
              className={inputClass}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
        {invoice === undefined || allocation === undefined ? null : (
          <p className="text-sm text-content-muted">
            {t('finance.payments.willAllocate', {
              amount: formatAmount(allocation.amount, invoice.currencyCode, locale),
              invoice: invoice.reference ?? '',
            })}
          </p>
        )}
        {record.isError ? <Failure error={record.error} /> : null}
      </form>
    </Dialog>
  );
}
