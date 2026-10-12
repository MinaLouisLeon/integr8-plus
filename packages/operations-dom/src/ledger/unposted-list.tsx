import { JOURNAL_SOURCE_KINDS } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  keys,
  type PostAllResult,
  type PostingReason,
  type PostingSourceKind,
  type PostingStatus,
  useOperations,
} from '../api.js';
import { BackLink, buttonClass, Dialog, Field, inputClass, Loading, useRowMenu } from '../ui.js';
import {
  Amount,
  AppLink,
  documentLabel,
  LedgerFailure,
  ManagementNote,
  Notice,
  POSTING_REASONS,
  useLedgerAccess,
  useReasonName,
} from './ledger-parts.js';

const STATUSES: readonly PostingStatus[] = ['pending', 'posted', 'skipped'];

/**
 * The unposted list (ADR-0009): sales documents and stock captured for the
 * ledger that did not post at once — automatic posting is off, the document
 * is in another currency or carries no cost, its month is locked, or it
 * follows an invoice still waiting — oldest first, with why. Those who may
 * post review one at a time or post everything that can go as proposed.
 */
export function UnpostedListScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const access = useLedgerAccess();
  const reasonName = useReasonName();
  const rowMenu = useRowMenu();
  const [status, setStatus] = useState<PostingStatus>('pending');
  const [kind, setKind] = useState<'' | PostingSourceKind>('');
  const [reason, setReason] = useState<'' | PostingReason>('');
  const [postingAll, setPostingAll] = useState(false);
  const [result, setResult] = useState<PostAllResult | null>(null);

  const query = {
    status,
    ...(kind === '' ? {} : { kind: [kind] }),
    ...(reason === '' || status !== 'pending' ? {} : { reason: [reason] }),
    limit: 50,
  };
  const postings = useInfiniteQuery({
    queryKey: keys.postings(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/ledger/postings', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = postings.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = postings.data?.pages[0]?.counts;

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.ledger} label={t('ledger.back')} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('ledger.unposted.title')}</h1>
          <p className="text-sm text-content-muted">{t('ledger.unposted.intro')}</p>
          <ManagementNote />
        </div>
        {access.post && status === 'pending' && (counts?.total ?? 0) > 0 ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => {
              setResult(null);
              setPostingAll(true);
            }}
          >
            {t('ledger.unposted.postAll')}
          </button>
        ) : null}
      </header>

      {counts === undefined || counts.total === 0 ? null : (
        <p className="text-sm text-content">
          {t('ledger.unposted.waitingCount', { count: counts.total })}{' '}
          {POSTING_REASONS.flatMap((candidate) => {
            const count = counts.byReason[candidate] ?? 0;
            return count === 0
              ? []
              : [
                  <span key={candidate} className="me-3 text-content-muted">
                    {t('ledger.home.byReason', { reason: reasonName(candidate), count })}
                  </span>,
                ];
          })}
        </p>
      )}

      {result === null ? null : <PostAllSummary result={result} />}

      <div role="group" aria-label={t('ledger.unposted.show')} className="flex flex-wrap gap-2">
        {STATUSES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={status === candidate}
            className={status === candidate ? buttonClass.primary : buttonClass.secondary}
            onClick={() => setStatus(candidate)}
          >
            {t(`ledger.postingStatus.${candidate}`)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('ledger.unposted.kind')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={kind}
              onChange={(event) => setKind(event.target.value as '' | PostingSourceKind)}
            >
              <option value="">{t('ledger.unposted.anyKind')}</option>
              {JOURNAL_SOURCE_KINDS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`ledger.source.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {status === 'pending' ? (
          <Field label={t('ledger.unposted.reason')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={reason}
                onChange={(event) => setReason(event.target.value as '' | PostingReason)}
              >
                <option value="">{t('ledger.unposted.anyReason')}</option>
                {POSTING_REASONS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {reasonName(candidate)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
      </div>

      {postings.isPending ? (
        <Loading />
      ) : postings.isError ? (
        <LedgerFailure error={postings.error} onRetry={() => void postings.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {status === 'pending' ? t('ledger.unposted.emptyPending') : t('ledger.unposted.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((posting) => {
              const label = documentLabel(posting, t);
              return (
                <li
                  key={posting.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  onContextMenu={rowMenu({ kind: 'posting', id: posting.id, label }, () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.unpostedItem(posting.id)),
                    },
                  ])}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <AppLink
                      to={paths.unpostedItem(posting.id)}
                      ltr={posting.label !== null}
                      className="self-start font-medium"
                    >
                      {label}
                    </AppLink>
                    <span className="text-sm text-content-muted">
                      {t(`ledger.source.${posting.source.kind}`)}
                      {posting.status === 'pending' && posting.reason !== null
                        ? ` · ${reasonName(posting.reason)}`
                        : null}
                      {posting.status === 'skipped' && posting.skipReason !== null ? (
                        <span dir="auto"> · {posting.skipReason}</span>
                      ) : null}
                      {posting.status === 'posted' &&
                      posting.journal !== null &&
                      posting.journal.reference !== null ? (
                        <>
                          {' · '}
                          <span dir="ltr">{posting.journal.reference}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
                    <span>{formatCalendarDate(posting.documentDate, { locale })}</span>
                    <span className="text-content">
                      <Amount value={posting.amount} currency={posting.currency} />
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {postings.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={postings.isFetchingNextPage}
              onClick={() => void postings.fetchNextPage()}
            >
              {t('ledger.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {postingAll ? (
        <PostAllDialog
          kind={kind}
          onClose={() => setPostingAll(false)}
          onDone={(done) => {
            setPostingAll(false);
            setResult(done);
          }}
        />
      ) : null}
    </div>
  );
}

/** Posts everything waiting that can go as proposed, of one kind or all. */
function PostAllDialog({
  kind,
  onClose,
  onDone,
}: {
  kind: '' | PostingSourceKind;
  onClose: () => void;
  onDone: (result: PostAllResult) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/postings/post-all', {
          body: kind === '' ? {} : { kind: [kind] },
        })
      ).data!,
    onSuccess: async (result) => {
      await queries.invalidateQueries({ queryKey: ['ledger'] });
      onDone(result);
    },
  });
  return (
    <Dialog
      title={t('ledger.unposted.postAllTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={post.isPending}
            onClick={() => post.mutate()}
          >
            {post.isPending ? t('ledger.unposted.posting') : t('ledger.unposted.postAll')}
          </button>
        </>
      }
    >
      <p>
        {kind === ''
          ? t('ledger.unposted.postAllIntro')
          : t('ledger.unposted.postAllKindIntro', { kind: t(`ledger.source.${kind}`) })}
      </p>
      <p>{t('ledger.unposted.postAllLeft')}</p>
      {post.isError ? <LedgerFailure error={post.error} /> : null}
    </Dialog>
  );
}

function PostAllSummary({ result }: { result: PostAllResult }) {
  const { t } = useTranslation();
  const reasonName = useReasonName();
  const still = POSTING_REASONS.flatMap((reason) => {
    const count = result.waiting[reason] ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  });
  return (
    <Notice>
      <p role="status" className="font-medium">
        {t('ledger.unposted.postAllDone', { posted: result.posted, skipped: result.skipped })}
      </p>
      {still.length === 0 ? null : (
        <>
          <p>{t('ledger.unposted.stillWaiting')}</p>
          <ul className="list-disc ps-5">
            {still.map(({ reason, count }) => (
              <li key={reason}>
                {t('ledger.home.byReason', { reason: reasonName(reason), count })}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.counts.total > 0 ? (
        <p>{t('ledger.unposted.waitingCount', { count: result.counts.total })}</p>
      ) : null}
    </Notice>
  );
}
