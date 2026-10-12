import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { type JournalDetail, keys, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  AppLink,
  JournalStatusBadge,
  journalTitle,
  LedgerFailure,
  LinesTable,
  ManagementNote,
  Notice,
  useKindName,
  useLedgerAccess,
  useLedgerOverview,
  useSourceLink,
} from './ledger-parts.js';

/**
 * One journal (ADR-0009): its number once posted, its date, who drafted and
 * who posted it, its lines and totals, the document it came from, and the
 * journal that reverses it or that it reverses. A draft is edited, posted —
 * by someone other than its drafter unless the owner allows self-approval,
 * which the journal then says — or discarded. A posted journal never
 * changes: it is corrected by a reversal.
 */
export function JournalScreen({ journalId }: { journalId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useLedgerAccess();
  const overview = useLedgerOverview();
  const kindName = useKindName();
  const sourceLink = useSourceLink();
  const [dialog, setDialog] = useState<'post' | 'discard' | 'reverse' | null>(null);

  const detail = useQuery({
    queryKey: keys.journal(journalId),
    queryFn: async () =>
      (await client.GET('/v1/ledger/journals/{journalId}', { params: { path: { journalId } } }))
        .data!,
  });
  const settle = async (next: JournalDetail) => {
    queries.setQueryData(keys.journal(next.id), next);
    await queries.invalidateQueries({ queryKey: ['ledger'] });
  };

  const back = <BackLink to={paths.journals} label={t('ledger.journals.back')} />;
  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <LedgerFailure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const journal = detail.data;
  const currency = overview.data?.currency ?? null;
  const own = access.userId !== null && journal.draftedBy.id === access.userId;
  const handWritten = journal.kind === 'manual' || journal.kind === 'opening';
  const selfApprovalAllowed = overview.data?.settings?.allowSelfApproval === true;
  const source = sourceLink(journal);
  const title = journalTitle(journal, t);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span {...(journal.reference === null ? {} : { dir: 'ltr' })}>{title}</span>
            <JournalStatusBadge status={journal.status} />
          </h1>
          <p className="text-sm text-content-muted">{kindName(journal.kind)}</p>
          <ManagementNote />
        </div>
        <div className="flex flex-wrap gap-2">
          {journal.can.edit ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => navigate(paths.editJournal(journal.id))}
            >
              {t('ledger.journal.edit')}
            </button>
          ) : null}
          {journal.can.post ? (
            <button type="button" className={buttonClass.primary} onClick={() => setDialog('post')}>
              {t('ledger.journal.post')}
            </button>
          ) : null}
          {journal.can.discard ? (
            <button
              type="button"
              className={buttonClass.danger}
              onClick={() => setDialog('discard')}
            >
              {t('ledger.journal.discard')}
            </button>
          ) : null}
          {journal.can.reverse ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setDialog('reverse')}
            >
              {t('ledger.journal.reverse')}
            </button>
          ) : null}
        </div>
      </header>

      {journal.status === 'draft' && handWritten && access.post && !journal.can.post && own ? (
        <Notice>
          <p>{t('ledger.journal.secondPerson')}</p>
        </Notice>
      ) : null}
      {journal.status === 'draft' && handWritten && !journal.totals.balanced ? (
        <Notice tone="warning">
          <p>{t('ledger.journal.unbalancedDraft')}</p>
        </Notice>
      ) : null}

      <section aria-labelledby="journal-facts" className={cardClass}>
        <h2 id="journal-facts" className="sr-only">
          {t('ledger.editor.details')}
        </h2>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('ledger.journal.entryDate')}>
            {formatCalendarDate(journal.entryDate, { locale })}
          </Fact>
          <Fact label={t('ledger.journal.draftedBy')}>{journal.draftedBy.name}</Fact>
          {journal.postedBy === null || journal.postedAt === null ? null : (
            <Fact label={t('ledger.journal.postedBy')}>
              {t('ledger.journal.byOn', {
                name: journal.postedBy.name,
                date: formatDateTime(journal.postedAt, { locale }),
              })}
            </Fact>
          )}
          {journal.memo === null || journal.memo === '' ? null : (
            <Fact label={t('ledger.journal.memo')} wide>
              <span dir="auto">{journal.memo}</span>
            </Fact>
          )}
          {journal.foreign === null ? null : (
            <Fact label={t('ledger.journal.rate')} wide>
              {t('ledger.journal.rateLine', {
                currency: journal.foreign.currency,
                rate: journal.foreign.rate,
                company: currency ?? '',
                source: journal.foreign.source,
              })}
            </Fact>
          )}
          {journal.source === null ? null : (
            <Fact label={t('ledger.journal.source')}>
              {source === undefined ? (
                t(`ledger.source.${journal.source.kind}`)
              ) : (
                <AppLink to={source}>
                  {t('ledger.journal.openSource', {
                    kind: t(`ledger.source.${journal.source.kind}`),
                  })}
                </AppLink>
              )}
            </Fact>
          )}
          {journal.reversalOf === null ? null : (
            <Fact label={t('ledger.journal.reverses')}>
              <AppLink to={paths.journal(journal.reversalOf)}>
                {t('ledger.journal.openReversed')}
              </AppLink>
            </Fact>
          )}
          {journal.reversedBy === null ? null : (
            <Fact label={t('ledger.journal.reversedBy')}>
              <AppLink to={paths.journal(journal.reversedBy)}>
                {t('ledger.journal.openReversal')}
              </AppLink>
            </Fact>
          )}
        </dl>
        {journal.selfApproved ? (
          <p className="text-sm text-content">{t('ledger.journal.selfApproved')}</p>
        ) : null}
      </section>

      <section aria-labelledby="journal-lines" className="flex flex-col gap-3">
        <h2 id="journal-lines" className="text-base font-semibold text-content">
          {t('ledger.editor.lines')}
        </h2>
        <LinesTable
          lines={journal.lines.map((line) => ({ ...line, key: line.id }))}
          currency={currency ?? ''}
          totals={journal.totals}
          foreignCurrency={journal.foreign?.currency}
        />
      </section>

      {dialog === 'post' ? (
        <PostDialog
          journal={journal}
          own={own}
          selfApprovalAllowed={selfApprovalAllowed}
          onClose={() => setDialog(null)}
          onDone={async (next) => {
            setDialog(null);
            await settle(next);
          }}
        />
      ) : null}
      {dialog === 'discard' ? (
        <DiscardDialog
          journal={journal}
          onClose={() => setDialog(null)}
          onDone={async () => {
            await queries.invalidateQueries({ queryKey: ['ledger'] });
            navigate(paths.journals);
          }}
        />
      ) : null}
      {dialog === 'reverse' ? (
        <ReverseDialog
          journal={journal}
          today={overview.data?.today ?? journal.entryDate}
          onClose={() => setDialog(null)}
          onDone={async (reversal) => {
            setDialog(null);
            queries.setQueryData(keys.journal(reversal.id), reversal);
            await queries.invalidateQueries({ queryKey: ['ledger'] });
            navigate(paths.journal(reversal.id));
          }}
        />
      ) : null}
    </div>
  );
}

function Fact({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content">{children}</dd>
    </div>
  );
}

/**
 * Posts a draft. The drafter confirms, in so many words, that they approve
 * their own journal — only where the owner allows it; anybody else confirms
 * that it will be numbered and never change.
 */
function PostDialog({
  journal,
  own,
  selfApprovalAllowed,
  onClose,
  onDone,
}: {
  journal: JournalDetail;
  own: boolean;
  selfApprovalAllowed: boolean;
  onClose: () => void;
  onDone: (next: JournalDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const selfApprove = own && selfApprovalAllowed;
  const [confirmed, setConfirmed] = useState(false);
  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/journals/{journalId}/post', {
          params: { path: { journalId: journal.id } },
          body: { selfApprove },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('ledger.journal.postTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={(selfApprove && !confirmed) || post.isPending}
            onClick={() => post.mutate()}
          >
            {post.isPending ? t('ledger.journal.posting') : t('ledger.journal.post')}
          </button>
        </>
      }
    >
      <p>{t('ledger.journal.postIntro')}</p>
      {selfApprove ? (
        <>
          <p>{t('ledger.journal.selfApproveIntro')}</p>
          <label className="flex items-start gap-2 text-sm text-content">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t('ledger.journal.selfApproveConfirm')}
          </label>
        </>
      ) : null}
      {post.isError ? <LedgerFailure error={post.error} /> : null}
    </Dialog>
  );
}

function DiscardDialog({
  journal,
  onClose,
  onDone,
}: {
  journal: JournalDetail;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const discard = useMutation({
    mutationFn: async () =>
      client.DELETE('/v1/ledger/journals/{journalId}', {
        params: { path: { journalId: journal.id } },
      }),
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('ledger.journal.discardTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={discard.isPending}
            onClick={() => discard.mutate()}
          >
            {t('ledger.journal.discard')}
          </button>
        </>
      }
    >
      <p>{t('ledger.journal.discardIntro')}</p>
      {discard.isError ? <LedgerFailure error={discard.error} /> : null}
    </Dialog>
  );
}

/** Posts the mirror image of a posted journal, on a date in an open month. */
function ReverseDialog({
  journal,
  today,
  onClose,
  onDone,
}: {
  journal: JournalDetail;
  today: string;
  onClose: () => void;
  onDone: (reversal: JournalDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [entryDate, setEntryDate] = useState(today < journal.entryDate ? journal.entryDate : today);
  const [memo, setMemo] = useState('');
  const body = {
    entryDate,
    ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
  };
  const idempotencyKey = useIdempotencyKey({ journal: journal.id, ...body });
  const reverse = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/journals/{journalId}/reverse', {
          params: {
            path: { journalId: journal.id },
            header: { 'Idempotency-Key': idempotencyKey },
          },
          body,
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('ledger.journal.reverseTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="submit"
            form="ledger-reverse"
            className={buttonClass.primary}
            disabled={entryDate === '' || reverse.isPending}
          >
            {reverse.isPending ? t('ledger.journal.reversing') : t('ledger.journal.reverse')}
          </button>
        </>
      }
    >
      <form
        id="ledger-reverse"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (entryDate !== '') {
            reverse.mutate();
          }
        }}
      >
        <p>{t('ledger.journal.reverseIntro')}</p>
        <Field label={t('ledger.journal.reverseDate')} hint={t('ledger.journal.reverseDateHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              required
              min={journal.entryDate}
              aria-describedby={describedBy}
              className={inputClass}
              value={entryDate}
              onChange={(event) => setEntryDate(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('ledger.journal.reverseMemo')} hint={t('ledger.journal.reverseMemoHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              dir="auto"
              maxLength={2000}
              aria-describedby={describedBy}
              className={inputClass}
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
            />
          )}
        </Field>
        {reverse.isError ? <LedgerFailure error={reverse.error} /> : null}
      </form>
    </Dialog>
  );
}
