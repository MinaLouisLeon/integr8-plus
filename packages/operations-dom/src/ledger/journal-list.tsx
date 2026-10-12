import { JOURNAL_KINDS } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type JournalKindKey, keys, useOperations } from '../api.js';
import { BackLink, buttonClass, Field, inputClass, Loading, useRowMenu } from '../ui.js';
import {
  Amount,
  AppLink,
  JournalStatusBadge,
  journalTitle,
  LedgerFailure,
  ManagementNote,
  useKindName,
  useLedgerAccess,
  useLedgerOverview,
} from './ledger-parts.js';

interface Filters {
  status: '' | 'draft' | 'posted';
  kind: '' | JournalKindKey;
  from: string;
  to: string;
  q: string;
}

const NO_FILTERS: Filters = { status: '', kind: '', from: '', to: '', q: '' };

/**
 * Journals, newest first (ADR-0009): posted ones by date and number, drafts
 * after them. Found by number (`JV-000123`) or words in the memo, by state,
 * kind and dates. Those who may post start a new journal from here.
 */
export function JournalListScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const access = useLedgerAccess();
  const overview = useLedgerOverview();
  const kindName = useKindName();
  const rowMenu = useRowMenu();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);

  const query = {
    ...(applied.status === '' ? {} : { status: applied.status }),
    ...(applied.kind === '' ? {} : { kind: [applied.kind] }),
    ...(applied.from === '' ? {} : { from: applied.from }),
    ...(applied.to === '' ? {} : { to: applied.to }),
    ...(applied.q === '' ? {} : { q: applied.q }),
    limit: 50,
  };
  const journals = useInfiniteQuery({
    queryKey: keys.journals(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/ledger/journals', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = journals.data?.pages.flatMap((page) => page.items) ?? [];
  const currency = overview.data?.currency ?? null;
  const filtered = JSON.stringify(applied) !== JSON.stringify(NO_FILTERS);
  const set = (change: Partial<Filters>) => setDraft({ ...draft, ...change });

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.ledger} label={t('ledger.back')} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('ledger.journals.title')}</h1>
          <ManagementNote />
        </div>
        {access.post && overview.data?.setUp === true ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => navigate(paths.newJournal())}
          >
            {t('ledger.journals.new')}
          </button>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ ...draft, q: draft.q.trim() });
        }}
      >
        <Field label={t('ledger.journals.search')} className="min-w-56 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={draft.q}
              onChange={(event) => set({ q: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('ledger.journals.status')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.status}
              onChange={(event) => set({ status: event.target.value as Filters['status'] })}
            >
              <option value="">{t('ledger.journals.anyStatus')}</option>
              <option value="posted">{t('ledger.journalStatus.posted')}</option>
              <option value="draft">{t('ledger.journalStatus.draft')}</option>
            </select>
          )}
        </Field>
        <Field label={t('ledger.journals.kind')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.kind}
              onChange={(event) => set({ kind: event.target.value as Filters['kind'] })}
            >
              <option value="">{t('ledger.journals.anyKind')}</option>
              {JOURNAL_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindName(kind)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('ledger.journals.from')}>
          {(id) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              className={inputClass}
              value={draft.from}
              onChange={(event) => set({ from: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('ledger.journals.to')}>
          {(id) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              className={inputClass}
              value={draft.to}
              onChange={(event) => set({ to: event.target.value })}
            />
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('ledger.apply')}
        </button>
      </form>

      {journals.isPending ? (
        <Loading />
      ) : journals.isError ? (
        <LedgerFailure error={journals.error} onRetry={() => void journals.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('ledger.journals.empty') : t('ledger.journals.emptyAll')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((journal) => {
              const title = journalTitle(journal, t);
              return (
                <li
                  key={journal.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  onContextMenu={rowMenu({ kind: 'journal', id: journal.id, label: title }, () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.journal(journal.id)),
                    },
                  ])}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <AppLink
                        to={paths.journal(journal.id)}
                        ltr={journal.reference !== null}
                        className="font-medium"
                      >
                        {title}
                      </AppLink>
                      <JournalStatusBadge status={journal.status} />
                    </span>
                    <span className="truncate text-sm text-content-muted">
                      {kindName(journal.kind)}
                      {journal.memo === null || journal.memo === '' ? null : (
                        <span dir="auto"> · {journal.memo}</span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
                    <span>{formatCalendarDate(journal.entryDate, { locale })}</span>
                    <span className="text-content">
                      <Amount value={journal.total} currency={currency} />
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {journals.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={journals.isFetchingNextPage}
              onClick={() => void journals.fetchNextPage()}
            >
              {t('ledger.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
