import {
  formatInvoiceReference,
  formatQuoteReference,
  formatReceiptReference,
  formatSalesOrderReference,
  formatWorkOrderReference,
  hasFeature,
  isZeroDecimal,
} from '@integr8/core';
import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { keys, type TimelineEntry, type TimelineSource, useOperations } from '../api.js';
import { InvoiceStatusBadge } from '../finance/finance-parts.js';
import { QuoteStatusBadge, SalesOrderStatusBadge } from '../sales/sales-parts.js';
import { buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import { ActivityPanel } from './activities.js';
import { formatAmount } from './lead-parts.js';

/**
 * Customer 360 (eighth round; ADR-0012): on the customer screen, the
 * customer's documents — quotes and sales orders, invoices and payments with
 * the account's balance, CRM activities — each in a tab shown only when its
 * module is on and the seat may read it, and one read-only timeline mixing
 * them with job events and submitted forms, newest first. Every entry opens
 * the record it comes from.
 */

type Tab = 'timeline' | 'quotes' | 'orders' | 'invoices' | 'payments' | 'activities';

const PAGE = 20;

/** Which tabs this seat sees: by module and permission, as the API decides. */
function useTabs(): Tab[] | undefined {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  if (me.data === undefined) {
    return undefined;
  }
  const { features, permissions } = me.data;
  const has = (
    feature: 'sales' | 'finance' | 'crm',
    permission: 'sales.read' | 'finance.read' | 'crm.read',
  ) => hasFeature(features, feature) && permissions.includes(permission);
  return [
    'timeline',
    ...(has('sales', 'sales.read') ? (['quotes', 'orders'] as const) : []),
    ...(has('finance', 'finance.read') ? (['invoices', 'payments'] as const) : []),
    ...(has('crm', 'crm.read') ? (['activities'] as const) : []),
  ];
}

export function CustomerRecordsSection({ customerId }: { customerId: string }) {
  const { t, i18n } = useTranslation();
  const tabs = useTabs();
  const [active, setActive] = useState<Tab>('timeline');
  const baseId = useId();
  const refs = useRef(new Map<Tab, HTMLButtonElement>());

  if (tabs === undefined) {
    return null;
  }
  const current = tabs.includes(active) ? active : 'timeline';

  // Arrow keys move along the tabs in reading order: right is next in
  // English and previous in Arabic.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(current);
    const forward = i18n.dir() === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = i18n.dir() === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const next =
      event.key === forward
        ? tabs[(index + 1) % tabs.length]
        : event.key === backward
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
      refs.current.get(next)?.focus();
    }
  };

  return (
    <section aria-labelledby={`${baseId}-heading`} className={cardClass}>
      <h2 id={`${baseId}-heading`} className="text-lg font-semibold text-content">
        {t('crm.customer360.heading')}
      </h2>
      <div
        role="tablist"
        aria-label={t('crm.customer360.tabs')}
        className="flex flex-wrap gap-1 border-b border-border-subtle"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            ref={(element) => {
              if (element === null) {
                refs.current.delete(tab);
              } else {
                refs.current.set(tab, element);
              }
            }}
            id={`${baseId}-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={tab === current}
            aria-controls={`${baseId}-panel-${tab}`}
            tabIndex={tab === current ? 0 : -1}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === current
                ? 'border-accent text-content'
                : 'border-transparent text-content-muted hover:text-content'
            }`}
            onClick={() => setActive(tab)}
            onKeyDown={onKeyDown}
          >
            {t(`crm.customer360.tab.${tab}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${current}`}
        aria-labelledby={`${baseId}-tab-${current}`}
        className="flex flex-col gap-3"
      >
        {current === 'timeline' ? <Timeline customerId={customerId} /> : null}
        {current === 'quotes' ? <Quotes customerId={customerId} /> : null}
        {current === 'orders' ? <SalesOrders customerId={customerId} /> : null}
        {current === 'invoices' ? <Invoices customerId={customerId} /> : null}
        {current === 'payments' ? <Payments customerId={customerId} /> : null}
        {current === 'activities' ? <Activities customerId={customerId} /> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function RecordLink({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      className="font-medium text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** A page of records: loading, the failure, nothing, the rows, and a way to the next page. */
function Paged<T>({
  query,
  empty,
  row,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
    data?: { pages: { items: T[] }[] } | undefined;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => unknown;
  };
  empty: string;
  row: (item: T) => ReactNode;
}) {
  const { t } = useTranslation();
  if (query.isPending) {
    return <Loading />;
  }
  if (query.isError) {
    return <Failure error={query.error} onRetry={() => void query.refetch()} />;
  }
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-content-muted">{empty}</p>;
  }
  return (
    <>
      <ul className="flex flex-col divide-y divide-border-subtle text-sm">{items.map(row)}</ul>
      {query.hasNextPage ? (
        <button
          type="button"
          className={`${buttonClass.secondary} self-center`}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('crm.customer360.loadMore')}
        </button>
      ) : null}
    </>
  );
}

const rowClass = 'flex flex-wrap items-center justify-between gap-2 py-2';

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function Quotes({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const query = useInfiniteQuery({
    queryKey: keys.quotes({ customerId, view: 'customer' }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/sales/quotes', {
          params: {
            query: {
              customerId,
              limit: PAGE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <Paged
      query={query}
      empty={t('crm.customer360.quotesEmpty')}
      row={(quote) => (
        <li key={quote.id} className={rowClass}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <RecordLink to={paths.quote(quote.id)}>
              <span dir="ltr">{quote.reference}</span>
            </RecordLink>
            <QuoteStatusBadge status={quote.status} expired={quote.expired} />
            <span className="truncate text-content-muted" dir="auto">
              {quote.title}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-3 text-content-muted tabular-nums">
            {quote.validUntil === null
              ? null
              : t('crm.customer360.validUntil', {
                  date: formatCalendarDate(quote.validUntil, { locale }),
                })}
            <span className="text-content">
              {formatAmount(quote.totals.total, quote.currencyCode, locale)}
            </span>
          </span>
        </li>
      )}
    />
  );
}

function SalesOrders({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const query = useInfiniteQuery({
    queryKey: keys.salesOrders({ customerId, view: 'customer' }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/sales/orders', {
          params: {
            query: {
              customerId,
              limit: PAGE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <Paged
      query={query}
      empty={t('crm.customer360.ordersEmpty')}
      row={(order) => (
        <li key={order.id} className={rowClass}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <RecordLink to={paths.salesOrder(order.id)}>
              <span dir="ltr">{order.reference}</span>
            </RecordLink>
            <SalesOrderStatusBadge status={order.status} />
            <span className="truncate text-content-muted" dir="auto">
              {order.title}
            </span>
          </span>
          <span className="text-content tabular-nums">
            {formatAmount(order.totals.total, order.currencyCode, locale)}
          </span>
        </li>
      )}
    />
  );
}

/** The account's balance per currency, then the invoices. */
function Invoices({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const account = useQuery({
    queryKey: keys.customerAccount(customerId),
    queryFn: async () =>
      (
        await client.GET('/v1/finance/customers/{customerId}/account', {
          params: { path: { customerId } },
        })
      ).data!,
  });
  const query = useInfiniteQuery({
    queryKey: keys.invoices({ customerId, view: 'customer' }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/finance/invoices', {
          params: {
            query: {
              customerId,
              limit: PAGE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <>
      <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-muted p-3 text-sm">
        <h3 className="font-semibold text-content">{t('crm.customer360.balance')}</h3>
        {account.isPending ? (
          <Loading />
        ) : account.isError ? (
          <Failure error={account.error} onRetry={() => void account.refetch()} />
        ) : account.data.accounts.length === 0 ? (
          <p className="text-content-muted">{t('finance.account.nothing')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
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
                        amount: formatAmount(row.net.replace(/^-/u, ''), row.currencyCode, locale),
                      })
                    : t('finance.account.net', {
                        amount: formatAmount(row.net, row.currencyCode, locale),
                      })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Paged
        query={query}
        empty={t('crm.customer360.invoicesEmpty')}
        row={(invoice) => (
          <li key={invoice.id} className={rowClass}>
            <span className="flex flex-wrap items-center gap-2">
              <RecordLink to={paths.invoice(invoice.id)}>
                <span dir="ltr">{invoice.reference ?? t('crm.customer360.draft')}</span>
              </RecordLink>
              <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
              {invoice.issueDate === null ? null : (
                <span className="text-content-muted">
                  {formatCalendarDate(invoice.issueDate, { locale })}
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-3 text-content-muted tabular-nums">
              <span>{formatAmount(invoice.amounts.total, invoice.currencyCode, locale)}</span>
              {isZeroDecimal(invoice.amounts.balance) ? null : (
                <span className="text-content">
                  {t('finance.invoices.owes', {
                    amount: formatAmount(invoice.amounts.balance, invoice.currencyCode, locale),
                  })}
                </span>
              )}
            </span>
          </li>
        )}
      />
    </>
  );
}

function Payments({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const query = useInfiniteQuery({
    queryKey: keys.payments({ customerId, view: 'customer' }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/finance/payments', {
          params: {
            query: {
              customerId,
              limit: PAGE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <Paged
      query={query}
      empty={t('crm.customer360.paymentsEmpty')}
      row={(payment) => (
        <li key={payment.id} className={rowClass}>
          <span className="flex flex-wrap items-center gap-2">
            <RecordLink to={paths.payment(payment.id)}>
              <span dir="ltr">{payment.reference}</span>
            </RecordLink>
            <span className="text-content-muted">
              {t('crm.customer360.received', {
                date: formatCalendarDate(payment.receivedOn, { locale }),
              })}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-3 tabular-nums">
            <span className="text-content">
              {formatAmount(payment.amount, payment.currencyCode, locale)}
            </span>
            {isZeroDecimal(payment.unallocated) ? null : (
              <span className="text-content-muted">
                {t('finance.payments.onAccount', {
                  amount: formatAmount(payment.unallocated, payment.currencyCode, locale),
                })}
              </span>
            )}
          </span>
        </li>
      )}
    />
  );
}

function Activities({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  return (
    <ActivityPanel
      links={{ customerIds: [customerId] }}
      canManage={me.data?.permissions.includes('crm.activity.manage') ?? false}
      heading={t('crm.customer.activities')}
    />
  );
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

const JOB_EVENTS = new Set([
  'created',
  'transitioned',
  'rescheduled',
  'updated',
  'assigned',
  'unassigned',
  'lead_changed',
  'signed_off',
  'visit_scheduled',
  'visit_rescheduled',
  'visit_done',
  'visit_cancelled',
  'visit_assigned',
  'visit_unassigned',
]);
const ACTIVITY_KINDS = new Set(['call', 'email', 'meeting', 'note', 'follow_up', 'task']);
const QUOTE_ANSWERS = new Set(['accepted', 'rejected', 'converted', 'cancelled']);

/** A short mark for each kind of entry, beside its name: never colour alone. */
const KIND_MARK: Record<TimelineEntry['kind'], string> = {
  activity: '✎',
  job_event: '⚒',
  submission: '☑',
  quote_issued: '❝',
  quote_answered: '❞',
  order_confirmed: '✓',
  invoice_issued: '⎙',
  invoice_voided: '⊘',
  payment_received: '¤',
};

export function Timeline({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [source, setSource] = useState<TimelineSource | ''>('');
  // What this seat may see, from the unfiltered first page, kept once a filter is chosen:
  // the filter offers only those.
  const [kept, setKept] = useState<readonly TimelineSource[] | null>(null);
  const sources = source === '' ? [] : [source];
  const query = useInfiniteQuery({
    queryKey: keys.customerTimeline(customerId, sources),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/customers/{customerId}/timeline', {
          params: {
            path: { customerId },
            query: {
              limit: PAGE,
              ...(source === '' ? {} : { sources: [source] }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const allowed = kept ?? query.data?.pages[0]?.sources ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-content-muted">{t('crm.customer360.timeline.intro')}</p>
        {allowed.length > 1 ? (
          <Field label={t('crm.customer360.timeline.source')}>
            {(id) => (
              <select
                id={id}
                className={`${inputClass} w-auto`}
                value={source}
                onChange={(event) => {
                  setKept(allowed);
                  setSource(event.target.value as TimelineSource | '');
                }}
              >
                <option value="">{t('crm.customer360.timeline.allSources')}</option>
                {allowed.map((value) => (
                  <option key={value} value={value}>
                    {t(`crm.customer360.timeline.sources.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
      </div>
      <Paged
        query={query}
        empty={t('crm.customer360.timeline.empty')}
        row={(entry) => (
          <TimelineRow key={`${entry.kind}:${entry.recordId}:${entry.at}`} entry={entry} />
        )}
      />
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  const ref = entry.reference;

  const { to, label } = ((): { to: string; label: string } => {
    switch (entry.kind) {
      case 'activity':
        return {
          to: paths.crmActivities,
          label: entry.title ?? t('crm.customer360.timeline.kind.activity'),
        };
      case 'job_event':
        return {
          to: paths.workOrder(entry.recordId),
          label: ref === null ? (entry.title ?? '') : formatWorkOrderReference(ref),
        };
      case 'submission':
        return {
          to: paths.submission(entry.recordId),
          label: entry.title ?? t('crm.customer360.timeline.kind.submission'),
        };
      case 'quote_issued':
      case 'quote_answered':
        return {
          to: paths.quote(entry.recordId),
          label: ref === null ? (entry.title ?? '') : formatQuoteReference(ref),
        };
      case 'order_confirmed':
        return {
          to: paths.salesOrder(entry.recordId),
          label: ref === null ? (entry.title ?? '') : formatSalesOrderReference(ref),
        };
      case 'invoice_issued':
      case 'invoice_voided':
        return {
          to: paths.invoice(entry.recordId),
          label: ref === null ? '' : formatInvoiceReference(ref),
        };
      case 'payment_received':
        return {
          to: paths.payment(entry.recordId),
          label: ref === null ? '' : formatReceiptReference(ref),
        };
    }
  })();

  // What happened, in this language: the server sends a key, a status or an amount.
  const detail = ((): string | null => {
    const value = entry.detail;
    if (value === null) {
      return null;
    }
    switch (entry.kind) {
      case 'activity':
        return ACTIVITY_KINDS.has(value) ? t(`crm.activityKind.${value as 'call'}`) : null;
      case 'job_event':
        return JOB_EVENTS.has(value)
          ? t(`crm.customer360.timeline.jobEvent.${value as 'created'}`)
          : null;
      case 'quote_answered':
        return QUOTE_ANSWERS.has(value) ? t(`sales.status.${value as 'accepted'}`) : null;
      case 'payment_received': {
        const [amount, currency] = value.split(' ');
        return amount === undefined ? null : formatAmount(amount, currency ?? null, locale);
      }
      default:
        return null;
    }
  })();
  // A job's or a document's own title, where the link shows its number.
  const title =
    entry.kind === 'activity' || entry.kind === 'submission' || entry.kind === 'payment_received'
      ? null
      : entry.title;

  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-content">
            <span aria-hidden="true">{KIND_MARK[entry.kind]}</span>
            {t(`crm.customer360.timeline.kind.${entry.kind}`)}
          </span>
          {label === '' ? null : (
            <RecordLink to={to}>
              <span dir="auto">{label}</span>
            </RecordLink>
          )}
          {detail === null ? null : <span className="text-content">{detail}</span>}
        </span>
        {title === null ? null : (
          <span className="truncate text-content-muted" dir="auto">
            {title}
          </span>
        )}
      </div>
      <time dateTime={entry.at} className="text-xs whitespace-nowrap text-content-muted">
        {formatDateTime(entry.at, { locale })}
      </time>
    </li>
  );
}
