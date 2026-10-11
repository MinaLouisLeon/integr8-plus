import { QUOTE_STATUSES } from '@integr8/core';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type QuoteStatus, useOperations } from '../api.js';
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
  QuoteStatusBadge,
  type SalesLineDraft,
  salesLineBodiesOf,
  salesLineValid,
  SalesLinesEditor,
} from './sales-parts.js';

/**
 * Quotes (CRM/ERP plan, phase S1): what has been offered to whom, by status,
 * and the dialog that drafts a new one — from the list, from a customer or
 * from an opportunity.
 */

export function NewQuoteDialog({
  customer,
  opportunity,
  onClose,
}: {
  customer?: { id: string; name: string };
  opportunity?: { id: string; title: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const [chosen, setChosen] = useState(customer ?? null);
  const [title, setTitle] = useState(opportunity?.title ?? '');
  const [validUntil, setValidUntil] = useState('');
  const [lines, setLines] = useState<SalesLineDraft[]>([]);
  const ready = chosen !== null && title.trim() !== '' && lines.every(salesLineValid);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/quotes', {
          body: {
            customerId: chosen!.id,
            title: title.trim(),
            ...(opportunity === undefined ? {} : { opportunityId: opportunity.id }),
            ...(validUntil === '' ? {} : { validUntil }),
            lines: salesLineBodiesOf(lines),
          },
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['sales'] });
      navigate(paths.quote(created.quote.id));
    },
  });

  return (
    <Dialog
      title={t('sales.quotes.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('sales.quotes.cancel')}
          </button>
          <button
            type="submit"
            form="sales-new-quote"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('sales.quotes.creating') : t('sales.quotes.create')}
          </button>
        </>
      }
    >
      <form
        id="sales-new-quote"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        {customer === undefined ? (
          <CustomerPicker label={t('sales.quotes.customer')} value={chosen} onChange={setChosen} />
        ) : (
          <p className="text-sm text-content">
            <span className="text-content-muted">{t('sales.quotes.customer')}: </span>
            {customer.name}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('sales.quotes.fields.title')}>
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
          <Field label={t('sales.quotes.validUntil')}>
            {(id) => (
              <input
                id={id}
                type="date"
                dir="ltr"
                className={inputClass}
                value={validUntil}
                onChange={(event) => setValidUntil(event.target.value)}
              />
            )}
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-content">{t('sales.quotes.lines')}</legend>
          <SalesLinesEditor lines={lines} onChange={setLines} />
        </fieldset>
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}

export function QuoteListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [status, setStatus] = useState<QuoteStatus | ''>('');
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
  const quotes = useInfiniteQuery({
    queryKey: keys.quotes(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/sales/quotes', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = quotes.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.crm} label={t('nav.backTo', { title: t('crm.overview.title') })} />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('sales.quotes.title')}</h1>
        {canManage ? (
          <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}>
            {t('sales.quotes.new')}
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
        <Field label={t('sales.quotes.search')} className="min-w-64 flex-1">
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
        <Field label={t('sales.quotes.anyStatus')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as QuoteStatus | '')}
            >
              <option value="">{t('sales.quotes.anyStatus')}</option>
              {QUOTE_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`sales.status.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('inventory.items.apply')}
        </button>
      </form>

      {quotes.isPending ? (
        <Loading />
      ) : quotes.isError ? (
        <Failure error={quotes.error} onRetry={() => void quotes.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' && status === '' ? t('sales.quotes.emptyAll') : t('sales.quotes.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((quote) => (
              <li
                key={quote.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'quote', id: quote.id, label: quote.reference },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.quote(quote.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <a
                      href={paths.quote(quote.id)}
                      dir="ltr"
                      className="font-medium text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.quote(quote.id));
                      }}
                    >
                      {quote.reference}
                    </a>
                    <QuoteStatusBadge status={quote.status} expired={quote.expired} />
                  </span>
                  <span className="truncate text-sm text-content-muted">
                    {quote.customer.name} · {quote.title}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-sm text-content-muted tabular-nums">
                  {quote.validUntil === null ? null : (
                    <span>
                      {t('sales.quotes.validUntil')}: {formatDate(quote.validUntil, { locale })}
                    </span>
                  )}
                  <span className="text-content">
                    {formatAmount(quote.totals.total, quote.currencyCode, locale)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {quotes.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={quotes.isFetchingNextPage}
              onClick={() => void quotes.fetchNextPage()}
            >
              {t('sales.quotes.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {creating ? <NewQuoteDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
