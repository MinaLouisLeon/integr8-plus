import { isZeroDecimal } from '@integr8/core';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import {
  buttonClass,
  DashboardBackLink,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import { RecordPaymentDialog, useFinanceAccess } from './finance-parts.js';

/**
 * Payments a company received (CRM/ERP plan, phase B1): newest first, with
 * what each still has on the customer's account, and recording one.
 */
export function PaymentListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const access = useFinanceAccess();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [unallocated, setUnallocated] = useState(false);
  const [recording, setRecording] = useState(false);

  const query = {
    ...(searched === '' ? {} : { q: searched }),
    ...(unallocated ? { unallocated: 'true' as const } : {}),
    limit: 50,
  };
  const payments = useInfiniteQuery({
    queryKey: keys.payments(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/finance/payments', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = payments.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('finance.payments.title')}</h1>
        {access.issue ? (
          <button type="button" className={buttonClass.primary} onClick={() => setRecording(true)}>
            {t('finance.payments.record')}
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
        <Field label={t('finance.payments.search')} className="min-w-64 flex-1">
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
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={unallocated}
            onChange={(event) => setUnallocated(event.target.checked)}
          />
          {t('finance.payments.unallocatedOnly')}
        </label>
        <button type="submit" className={buttonClass.secondary}>
          {t('inventory.items.apply')}
        </button>
      </form>

      {payments.isPending ? (
        <Loading />
      ) : payments.isError ? (
        <Failure error={payments.error} onRetry={() => void payments.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' && !unallocated
            ? t('finance.payments.emptyAll')
            : t('finance.payments.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'payment', id: payment.id, label: payment.reference },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.payment(payment.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <a
                    href={paths.payment(payment.id)}
                    dir="ltr"
                    className="self-start font-medium text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.payment(payment.id));
                    }}
                  >
                    {payment.reference}
                  </a>
                  <span className="truncate text-sm text-content-muted">
                    {payment.customer.name} · {t(`finance.method.${payment.method}`)}
                    {payment.paymentReference === null ? null : (
                      <span dir="auto"> · {payment.paymentReference}</span>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted tabular-nums">
                  <span>{formatDate(payment.receivedOn, { locale })}</span>
                  <span className={payment.reversed ? 'text-content line-through' : 'text-content'}>
                    {formatAmount(payment.amount, payment.currencyCode, locale)}
                  </span>
                  {payment.reversed ? (
                    <span className="inline-flex items-center rounded-full border border-danger px-2 py-0.5 text-xs font-medium text-danger">
                      {t('finance.payments.reversed')}
                    </span>
                  ) : null}
                  {isZeroDecimal(payment.unallocated) ? null : (
                    <span>
                      {t('finance.payments.onAccount', {
                        amount: formatAmount(payment.unallocated, payment.currencyCode, locale),
                      })}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {payments.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={payments.isFetchingNextPage}
              onClick={() => void payments.fetchNextPage()}
            >
              {t('finance.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {recording ? <RecordPaymentDialog onClose={() => setRecording(false)} /> : null}
    </div>
  );
}
