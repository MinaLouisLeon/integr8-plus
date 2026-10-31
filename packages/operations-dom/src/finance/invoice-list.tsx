import { INVOICE_ORDER_BASES, INVOICE_STATUSES, type InvoiceOrderBasis } from '@integr8/core';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type InvoiceStatus, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import {
  type SalesLineDraft,
  salesLineBodiesOf,
  salesLineValid,
  SalesLinesEditor,
} from '../sales/sales-parts.js';
import {
  buttonClass,
  DashboardBackLink,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import { InvoiceStatusBadge, PartsNotYetBilledBadge, useFinanceAccess } from './finance-parts.js';

/**
 * A company's invoices (CRM/ERP plan, phase B1): what customers owe, by
 * status, with those past due flagged — and the dialogs that draft one,
 * blank or from a sales order.
 */

export function NewInvoiceDialog({
  customer,
  onClose,
}: {
  customer?: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const [chosen, setChosen] = useState(customer ?? null);
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<SalesLineDraft[]>([]);
  const ready = chosen !== null && lines.every(salesLineValid);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/invoices', {
          body: {
            customerId: chosen!.id,
            ...(dueDate === '' ? {} : { dueDate }),
            lines: salesLineBodiesOf(lines),
          },
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['finance'] });
      navigate(paths.invoice(created.invoice.id));
    },
  });

  return (
    <Dialog
      title={t('finance.invoices.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('finance.cancel')}
          </button>
          <button
            type="submit"
            form="finance-new-invoice"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('finance.invoices.creating') : t('finance.invoices.create')}
          </button>
        </>
      }
    >
      <form
        id="finance-new-invoice"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
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
        <Field label={t('finance.invoices.dueDate')} hint={t('finance.invoices.dueDateHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              aria-describedby={describedBy}
              className={inputClass}
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-content">
            {t('finance.invoices.lines')}
          </legend>
          <SalesLinesEditor lines={lines} onChange={setLines} />
        </fieldset>
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}

/** Drafts an invoice from a sales order: what was delivered, or everything ordered. */
export function InvoiceFromOrderDialog({
  orderId,
  onClose,
}: {
  orderId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const [basis, setBasis] = useState<InvoiceOrderBasis>('delivered');
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/invoices/from-order', {
          body: { salesOrderId: orderId, basis },
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['finance'] });
      navigate(paths.invoice(created.invoice.id));
    },
  });
  return (
    <Dialog
      title={t('finance.invoices.fromOrderTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('finance.cancel')}
          </button>
          <button
            type="submit"
            form="finance-invoice-from-order"
            className={buttonClass.primary}
            disabled={create.isPending}
          >
            {create.isPending ? t('finance.invoices.creating') : t('finance.invoices.create')}
          </button>
        </>
      }
    >
      <form
        id="finance-invoice-from-order"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <p className="text-sm text-content">{t('finance.invoices.fromOrderIntro')}</p>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="sr-only">{t('finance.invoices.fromOrderTitle')}</legend>
          {INVOICE_ORDER_BASES.map((candidate) => (
            <label key={candidate} className="flex items-center gap-2">
              <input
                type="radio"
                name="finance-order-basis"
                checked={basis === candidate}
                onChange={() => setBasis(candidate)}
              />
              {t(`finance.invoices.basis.${candidate}`)}
            </label>
          ))}
        </fieldset>
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}

export function InvoiceListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const access = useFinanceAccess();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [overdue, setOverdue] = useState(false);
  // Jobs with parts recorded after they were invoiced, waiting for a follow-up (0062).
  const [partsNotBilled, setPartsNotBilled] = useState(false);
  const [creating, setCreating] = useState(false);

  const query = {
    ...(searched === '' ? {} : { q: searched }),
    ...(status === '' ? {} : { status: [status] }),
    ...(overdue ? { overdue: 'true' as const } : {}),
    ...(partsNotBilled ? { partsNotBilled: 'true' as const } : {}),
    limit: 50,
  };
  const invoices = useInfiniteQuery({
    queryKey: keys.invoices(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/finance/invoices', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = invoices.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('finance.invoices.title')}</h1>
        <div className="flex flex-wrap gap-2">
          <a
            href={paths.financeSettings}
            className={buttonClass.secondary}
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.financeSettings);
            }}
          >
            {t('finance.settings.title')}
          </a>
          {access.manage ? (
            <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}>
              {t('finance.invoices.new')}
            </button>
          ) : null}
        </div>
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(text.trim());
        }}
      >
        <Field label={t('finance.invoices.search')} className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('finance.anyStatus')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as InvoiceStatus | '')}
            >
              <option value="">{t('finance.anyStatus')}</option>
              {INVOICE_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`finance.status.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={overdue}
            onChange={(event) => setOverdue(event.target.checked)}
          />
          {t('finance.invoices.overdueOnly')}
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={partsNotBilled}
            onChange={(event) => setPartsNotBilled(event.target.checked)}
          />
          {t('finance.invoices.partsNotBilledOnly')}
        </label>
        <button type="submit" className={buttonClass.secondary}>
          {t('inventory.items.apply')}
        </button>
      </form>

      {invoices.isPending ? (
        <Loading />
      ) : invoices.isError ? (
        <Failure error={invoices.error} onRetry={() => void invoices.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' && status === '' && !overdue && !partsNotBilled
            ? t('finance.invoices.emptyAll')
            : t('finance.invoices.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((invoice) => {
              const label = invoice.reference ?? t('finance.invoices.draftLabel');
              return (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  onContextMenu={rowMenu({ kind: 'invoice', id: invoice.id, label }, () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.invoice(invoice.id)),
                    },
                  ])}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <a
                        href={paths.invoice(invoice.id)}
                        dir="ltr"
                        className="font-medium text-accent underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.invoice(invoice.id));
                        }}
                      >
                        {label}
                      </a>
                      <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
                      {invoice.partsNotYetBilled ? <PartsNotYetBilledBadge /> : null}
                    </span>
                    <span className="truncate text-sm text-content-muted">
                      {invoice.customer.name}
                      {invoice.source === null ? null : (
                        <span dir="ltr"> · {invoice.source.reference}</span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted tabular-nums">
                    {invoice.dueDate === null ? null : (
                      <span>
                        {t('finance.invoices.dueOn', {
                          date: formatDate(invoice.dueDate, { locale }),
                        })}
                      </span>
                    )}
                    <span className="text-content">
                      {formatAmount(invoice.amounts.total, invoice.currencyCode, locale)}
                    </span>
                    {invoice.status === 'partially_paid' || invoice.status === 'issued' ? (
                      <span>
                        {t('finance.invoices.owes', {
                          amount: formatAmount(
                            invoice.amounts.balance,
                            invoice.currencyCode,
                            locale,
                          ),
                        })}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {invoices.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={invoices.isFetchingNextPage}
              onClick={() => void invoices.fetchNextPage()}
            >
              {t('finance.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {creating ? <NewInvoiceDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
