import { EXPENSE_CLAIM_STATUSES } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type ExpenseClaimStatus, keys, useOperations } from '../api.js';
import { AppLink, Amount } from '../ledger/ledger-parts.js';
import { buttonClass, DashboardBackLink, Field, inputClass, Loading, useRowMenu } from '../ui.js';
import { ClaimStatusBadge, ExpenseFailure, Notice, useExpenseAccess } from './expense-parts.js';

type Scope = 'mine' | 'all';

interface Filters {
  status: ExpenseClaimStatus | '';
  q: string;
}

/** One's own claims start with everything; the approvers' list with what waits for them. */
const START: Record<Scope, Filters> = {
  mine: { status: '', q: '' },
  all: { status: 'submitted', q: '' },
};

/** The signed-in person's own expense claims, newest first, with a way to claim another. */
export function MyExpenseClaimsScreen() {
  return <ClaimList scope="mine" />;
}

/**
 * Everybody's expense claims, for the owner, admins and HR managers: those
 * waiting for a decision first, and how many there are, then any status.
 */
export function ExpenseClaimsScreen() {
  return <ClaimList scope="all" />;
}

function ClaimList({ scope }: { scope: Scope }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const access = useExpenseAccess();
  const rowMenu = useRowMenu();
  const [draft, setDraft] = useState<Filters>(START[scope]);
  const [applied, setApplied] = useState<Filters>(START[scope]);

  const query = {
    scope,
    ...(applied.status === '' ? {} : { status: applied.status }),
    ...(applied.q === '' ? {} : { q: applied.q }),
    limit: 50,
  };
  const claims = useInfiniteQuery({
    queryKey: keys.expenseClaims(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/expenses', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Everybody's claims are for approvers; nobody else is sent asking.
    enabled: scope === 'mine' || access.approve,
  });
  const rows = claims.data?.pages.flatMap((page) => page.items) ?? [];
  const waiting = claims.data?.pages[0]?.waiting ?? null;
  const filtered = JSON.stringify(applied) !== JSON.stringify(START[scope]);
  const set = (change: Partial<Filters>) => setDraft({ ...draft, ...change });
  const showWaiting = () => {
    const next = { status: 'submitted' as const, q: '' };
    setDraft(next);
    setApplied(next);
  };

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">
          {t(scope === 'mine' ? 'expenses.mine.title' : 'expenses.all.title')}
        </h1>
        <p className="text-sm text-content-muted">
          {t(scope === 'mine' ? 'expenses.mine.intro' : 'expenses.all.intro')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {scope === 'all' && access.approve ? (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => navigate(paths.expenseCategories)}
          >
            {t('expenses.all.categories')}
          </button>
        ) : null}
        {scope === 'mine' && access.submit ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => navigate(paths.newExpenseClaim)}
          >
            {t('expenses.mine.claim')}
          </button>
        ) : null}
      </div>
    </header>
  );

  if (scope === 'all' && access.loaded && !access.approve) {
    return (
      <div className="flex flex-col gap-6 text-start">
        <DashboardBackLink />
        {header}
        <Notice>
          <p>{access.enabled ? t('expenses.all.notApprover') : t('errors.featureDisabled')}</p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      {header}

      {scope === 'all' && waiting !== null ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle bg-surface-muted px-4 py-3 text-sm text-content"
        >
          <span>
            {waiting === 0
              ? t('expenses.all.noneWaiting')
              : t('expenses.all.waiting', { count: waiting })}
          </span>
          {waiting > 0 && applied.status !== 'submitted' ? (
            <button type="button" className={buttonClass.ghost} onClick={showWaiting}>
              {t('expenses.all.showWaiting')}
            </button>
          ) : null}
        </p>
      ) : null}

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ ...draft, q: draft.q.trim() });
        }}
      >
        <Field
          label={t('expenses.list.search')}
          hint={t('expenses.list.searchHint')}
          className="min-w-48 flex-1"
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="search"
              dir="ltr"
              maxLength={40}
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.q}
              onChange={(event) => set({ q: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('expenses.list.status')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.status}
              onChange={(event) => set({ status: event.target.value as Filters['status'] })}
            >
              <option value="">{t('expenses.list.anyStatus')}</option>
              {EXPENSE_CLAIM_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`expenses.status.${status}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('expenses.apply')}
        </button>
      </form>

      {claims.isPending ? (
        <Loading />
      ) : claims.isError ? (
        <ExpenseFailure error={claims.error} onRetry={() => void claims.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered || scope === 'all' ? t('expenses.list.empty') : t('expenses.mine.emptyAll')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((claim) => (
              <li
                key={claim.id}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'expenseClaim', id: claim.id, label: claim.reference },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.expenseClaim(claim.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <AppLink to={paths.expenseClaim(claim.id)} className="font-medium" ltr>
                      {claim.reference}
                    </AppLink>
                    <ClaimStatusBadge status={claim.status} />
                    {scope === 'all' ? (
                      <span className="text-sm text-content" dir="auto">
                        {claim.claimant.name}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-content-muted">
                    <span dir="auto">{claim.category.name}</span>
                    {' · '}
                    {t('expenses.list.spentOn', {
                      date: formatCalendarDate(claim.spentOn, { locale }),
                    })}
                  </span>
                  <span className="max-w-prose truncate text-sm text-content-muted" dir="auto">
                    {claim.description}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-0.5 text-sm">
                  <Amount value={claim.amount} currency={claim.currency} strong />
                  {claim.status === 'approved' && claim.settleVia !== null ? (
                    <span className="text-content-muted">
                      {t(`expenses.settleVia.${claim.settleVia}`)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {claims.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={claims.isFetchingNextPage}
              onClick={() => void claims.fetchNextPage()}
            >
              {t('expenses.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
