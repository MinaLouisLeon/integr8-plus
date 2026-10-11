import { SALES_ORDER_STATUSES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type SalesOrderStatus, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import {
  BackLink,
  buttonClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import {
  type SalesLineDraft,
  salesLineBodiesOf,
  salesLineValid,
  SalesLinesEditor,
  SalesOrderStatusBadge,
  ToOrderBadge,
} from './sales-parts.js';

/**
 * Sales orders (CRM/ERP plan, phase S1): what the company has promised to
 * deliver, by status, with the ones short of stock flagged — and the dialog
 * that drafts one directly, without a quote.
 */

export function NewSalesOrderDialog({
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
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<SalesLineDraft[]>([]);
  const ready = chosen !== null && title.trim() !== '' && lines.every(salesLineValid);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/orders', {
          body: { customerId: chosen!.id, title: title.trim(), lines: salesLineBodiesOf(lines) },
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['sales'] });
      navigate(paths.salesOrder(created.order.id));
    },
  });

  return (
    <Dialog
      title={t('sales.orders.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('sales.orders.cancel')}
          </button>
          <button
            type="submit"
            form="sales-new-order"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('sales.orders.creating') : t('sales.orders.create')}
          </button>
        </>
      }
    >
      <form
        id="sales-new-order"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        {customer === undefined ? (
          <CustomerPicker label={t('sales.orders.customer')} value={chosen} onChange={setChosen} />
        ) : (
          <p className="text-sm text-content">
            <span className="text-content-muted">{t('sales.orders.customer')}: </span>
            {customer.name}
          </p>
        )}
        <Field label={t('sales.orders.fields.title')}>
          {(id) => (
            <input
              id={id}
              required
              maxLength={200}
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-content">{t('sales.orders.lines')}</legend>
          <SalesLinesEditor lines={lines} onChange={setLines} />
        </fieldset>
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}

export function SalesOrderListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [status, setStatus] = useState<SalesOrderStatus | ''>('');
  const [creating, setCreating] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const canManage = me.data?.permissions.includes('sales.manage') ?? false;

  const query = {
    ...(searched === '' ? {} : { q: searched }),
    ...(status === '' ? {} : { status: [status] }),
    limit: 50,
  };
  const orders = useInfiniteQuery({
    queryKey: keys.salesOrders(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/sales/orders', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = orders.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.quotes} label={t('sales.quotes.back')} />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('sales.orders.title')}</h1>
        {canManage ? (
          <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}>
            {t('sales.orders.new')}
          </button>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(text.trim());
        }}
      >
        <Field label={t('sales.orders.search')} className="min-w-64 flex-1">
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
        <Field label={t('sales.orders.anyStatus')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as SalesOrderStatus | '')}
            >
              <option value="">{t('sales.orders.anyStatus')}</option>
              {SALES_ORDER_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`sales.orderStatus.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('inventory.items.apply')}
        </button>
      </form>

      {orders.isPending ? (
        <Loading />
      ) : orders.isError ? (
        <Failure error={orders.error} onRetry={() => void orders.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' && status === '' ? t('sales.orders.emptyAll') : t('sales.orders.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'salesOrder', id: order.id, label: order.reference },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.salesOrder(order.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <a
                      href={paths.salesOrder(order.id)}
                      dir="ltr"
                      className="font-medium text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.salesOrder(order.id));
                      }}
                    >
                      {order.reference}
                    </a>
                    <SalesOrderStatusBadge status={order.status} />
                    {order.toOrder ? <ToOrderBadge /> : null}
                  </span>
                  <span className="truncate text-sm text-content-muted">
                    {order.customer.name} · {order.title}
                    {order.quote === null ? null : (
                      <span dir="ltr"> · {order.quote.reference}</span>
                    )}
                  </span>
                </div>
                <span className="text-sm text-content tabular-nums">
                  {formatAmount(order.totals.total, order.currencyCode, locale)}
                </span>
              </li>
            ))}
          </ul>
          {orders.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={orders.isFetchingNextPage}
              onClick={() => void orders.fetchNextPage()}
            >
              {t('sales.orders.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {creating ? <NewSalesOrderDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
