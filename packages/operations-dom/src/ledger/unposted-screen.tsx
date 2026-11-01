import { convertLines, journalTotals } from '@integr8/core';
import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { keys, type PostingDetail, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  Amount,
  AppLink,
  documentLabel,
  isRate,
  JournalLinesEditor,
  LedgerFailure,
  lineBodies,
  lineDraftOf,
  type LineDraft,
  linesReady,
  LinesTable,
  ManagementNote,
  Notice,
  useLedgerAccounts,
  useLedgerOverview,
  useReasonName,
} from './ledger-parts.js';

/**
 * One document from the unposted list (ADR-0009) and the journal it would
 * post. Those who may post it post it as proposed, on another date in an
 * open month, or with the lines written out — which stock without a cost
 * needs. A document in another currency needs the rate to the company's
 * currency and where it came from; the server converts it line by line. A
 * credit note or void waits for its invoice. Anything can be set aside with
 * a reason instead.
 */
export function UnpostedScreen({ postingId }: { postingId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const reasonName = useReasonName();
  const [skipping, setSkipping] = useState(false);

  const detail = useQuery({
    queryKey: keys.posting(postingId),
    queryFn: async () =>
      (await client.GET('/v1/ledger/postings/{postingId}', { params: { path: { postingId } } }))
        .data!,
  });

  const back = <BackLink to={paths.unposted} label={t('ledger.unposted.back')} />;
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

  const posting = detail.data;
  const label = documentLabel(posting, t);
  const source = posting.source;
  const documentLink =
    source.kind === 'invoice' || source.kind === 'invoice_void'
      ? paths.invoice(source.id)
      : source.kind === 'payment' || source.kind === 'payment_reversal'
        ? paths.payment(source.id)
        : undefined;

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
          <span {...(posting.label === null ? {} : { dir: 'ltr' })}>{label}</span>
          <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-content">
            {t(`ledger.postingStatus.${posting.status}`)}
          </span>
        </h1>
        <p className="text-sm text-content-muted">
          {t(`ledger.source.${source.kind}`)}
          {' · '}
          {formatCalendarDate(posting.documentDate, { locale })}
          {' · '}
          <Amount value={posting.amount} currency={posting.currency} />
        </p>
        {documentLink === undefined ? null : (
          <AppLink to={documentLink} className="self-start text-sm">
            {t('ledger.unposted.openDocument')}
          </AppLink>
        )}
        <ManagementNote />
      </header>

      {posting.status === 'pending' && posting.reason !== null ? (
        <Notice tone="warning">
          <p className="font-medium">
            {t('ledger.unposted.why', { reason: reasonName(posting.reason) })}
          </p>
          <p>{t(`ledger.reasonHelp.${posting.reason}`)}</p>
          {posting.detail === null ? null : (
            <p className="text-content-muted" dir="auto">
              {posting.detail}
            </p>
          )}
        </Notice>
      ) : null}

      {posting.invoice === null ? null : (
        <p className="text-sm text-content">
          {t('ledger.unposted.follows', {
            invoice: posting.invoice.label ?? t('ledger.source.invoice'),
            status: t(`ledger.postingStatus.${posting.invoice.status}`),
          })}{' '}
          <AppLink to={paths.unpostedItem(posting.invoice.id)}>
            {t('ledger.unposted.openInvoiceEntry')}
          </AppLink>
        </p>
      )}

      {posting.status === 'posted' && posting.journal !== null ? (
        <Notice>
          <p>
            {posting.resolvedBy === null || posting.resolvedAt === null
              ? t('ledger.unposted.posted')
              : t('ledger.unposted.postedBy', {
                  name: posting.resolvedBy.name,
                  date: formatDateTime(posting.resolvedAt, { locale }),
                })}{' '}
            <AppLink
              to={paths.journal(posting.journal.id)}
              ltr={posting.journal.reference !== null}
            >
              {posting.journal.reference ?? t('ledger.unposted.openJournal')}
            </AppLink>
          </p>
        </Notice>
      ) : null}
      {posting.status === 'skipped' ? (
        <Notice>
          <p>
            {posting.resolvedBy === null || posting.resolvedAt === null
              ? t('ledger.unposted.skipped')
              : t('ledger.unposted.skippedBy', {
                  name: posting.resolvedBy.name,
                  date: formatDateTime(posting.resolvedAt, { locale }),
                })}
          </p>
          {posting.skipReason === null ? null : <p dir="auto">{posting.skipReason}</p>}
        </Notice>
      ) : null}

      <section aria-labelledby="posting-proposal" className="flex flex-col gap-3">
        <h2 id="posting-proposal" className="text-base font-semibold text-content">
          {t('ledger.unposted.proposal')}
        </h2>
        {posting.lines.length === 0 ? (
          <p className="text-sm text-content-muted">{t('ledger.unposted.noProposal')}</p>
        ) : (
          <LinesTable
            lines={posting.lines.map((line, index) => ({ ...line, key: String(index) }))}
            currency={posting.currency}
            totals={posting.totals}
          />
        )}
      </section>

      {posting.can.post ? <PostForm posting={posting} /> : null}

      {posting.can.skip ? (
        <div>
          <button type="button" className={buttonClass.secondary} onClick={() => setSkipping(true)}>
            {t('ledger.unposted.skip')}
          </button>
        </div>
      ) : null}

      {skipping ? (
        <SkipDialog
          posting={posting}
          onClose={() => setSkipping(false)}
          onDone={async (next) => {
            setSkipping(false);
            queries.setQueryData(keys.posting(postingId), next);
            await queries.invalidateQueries({ queryKey: ['ledger'] });
          }}
        />
      ) : null}
    </div>
  );
}

/** How a waiting document is posted: as proposed, on another date, written out, at a rate. */
function PostForm({ posting }: { posting: PostingDetail }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const overview = useLedgerOverview();
  const foreign = posting.currency !== posting.companyCurrency;
  const mustWrite = posting.reason === 'cost_unknown';
  const [entryDate, setEntryDate] = useState(posting.documentDate);
  const [writing, setWriting] = useState(mustWrite);
  const [lines, setLines] = useState<LineDraft[] | null>(null);
  const [rate, setRate] = useState('');
  const [rateSource, setRateSource] = useState('');
  const accounts = useLedgerAccounts(false, writing);

  // The proposal as lines to edit, worked out once so each keeps its key.
  const proposed = useMemo(() => posting.lines.map(lineDraftOf), [posting.lines]);
  const written = lines ?? proposed;
  const rateValid = isRate(rate);
  const ready =
    entryDate !== '' &&
    (!foreign || (rateValid && rateSource.trim() !== '')) &&
    (!writing || linesReady(written));
  const body = {
    ...(entryDate === posting.documentDate ? {} : { entryDate }),
    ...(writing ? { lines: lineBodies(written) } : {}),
    ...(foreign ? { rate: rate.trim(), rateSource: rateSource.trim() } : {}),
  };
  const idempotencyKey = useIdempotencyKey({ posting: posting.id, ...body });
  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/postings/{postingId}/post', {
          params: {
            path: { postingId: posting.id },
            header: { 'Idempotency-Key': idempotencyKey },
          },
          body,
        })
      ).data!,
    onSuccess: async (journal) => {
      queries.setQueryData(keys.journal(journal.id), journal);
      await queries.invalidateQueries({ queryKey: ['ledger'] });
      navigate(paths.journal(journal.id));
    },
  });

  const preview =
    foreign && rateValid && !writing && posting.lines.length > 0
      ? convertLines(posting.lines, rate.trim())
      : undefined;

  return (
    <form
      aria-labelledby="posting-post"
      className={cardClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          post.mutate();
        }
      }}
    >
      <h2 id="posting-post" className="text-base font-semibold text-content">
        {t('ledger.unposted.postTitle')}
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('ledger.unposted.entryDate')} hint={t('ledger.unposted.entryDateHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              required
              aria-describedby={describedBy}
              className={inputClass}
              value={entryDate}
              onChange={(event) => setEntryDate(event.target.value)}
            />
          )}
        </Field>
        {foreign ? (
          <>
            <Field
              label={t('ledger.unposted.rate', {
                currency: posting.currency,
                company: posting.companyCurrency,
              })}
              hint={t('ledger.unposted.rateHint', {
                currency: posting.currency,
                company: posting.companyCurrency,
              })}
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  required
                  inputMode="decimal"
                  dir="ltr"
                  aria-describedby={describedBy}
                  aria-invalid={rate !== '' && !rateValid}
                  className={inputClass}
                  value={rate}
                  onChange={(event) => setRate(event.target.value.trim())}
                />
              )}
            </Field>
            <Field
              label={t('ledger.unposted.rateSource')}
              hint={t('ledger.unposted.rateSourceHint')}
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  required
                  maxLength={200}
                  dir="auto"
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={rateSource}
                  onChange={(event) => setRateSource(event.target.value)}
                />
              )}
            </Field>
          </>
        ) : null}
      </div>
      {foreign ? (
        <p className="text-sm text-content-muted">
          {t('ledger.unposted.foreignNote', {
            currency: posting.currency,
            company: posting.companyCurrency,
          })}
        </p>
      ) : null}

      {preview === undefined ? null : (
        <Labelled label={t('ledger.unposted.preview', { company: posting.companyCurrency })}>
          <LinesTable
            lines={preview.map((line, index) => ({ ...line, key: String(index) }))}
            currency={posting.companyCurrency}
            totals={journalTotals(preview)}
            foreignCurrency={posting.currency}
          />
        </Labelled>
      )}

      {mustWrite ? (
        <p className="text-sm text-content">{t('ledger.unposted.mustWrite')}</p>
      ) : (
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={writing}
            onChange={(event) => {
              setWriting(event.target.checked);
              // In another currency, start from the proposal at the rate typed so far.
              if (event.target.checked && lines === null && foreign && rateValid) {
                setLines(convertLines(posting.lines, rate.trim()).map(lineDraftOf));
              }
            }}
          />
          {t('ledger.unposted.writeOut')}
        </label>
      )}
      {writing ? (
        accounts.isPending ? (
          <Loading />
        ) : accounts.isError ? (
          <LedgerFailure error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : (
          <>
            <p className="text-sm text-content-muted">
              {t('ledger.unposted.writeOutHint', { company: posting.companyCurrency })}
            </p>
            <JournalLinesEditor
              lines={written}
              onChange={setLines}
              accounts={accounts.data}
              currency={posting.companyCurrency}
              receivablesId={overview.data?.settings?.accounts.receivables}
            />
          </>
        )
      ) : null}

      {post.isError ? <LedgerFailure error={post.error} /> : null}
      <div>
        <button type="submit" className={buttonClass.primary} disabled={!ready || post.isPending}>
          {post.isPending
            ? t('ledger.unposted.posting')
            : writing
              ? t('ledger.unposted.postWritten')
              : t('ledger.unposted.postProposed')}
        </button>
      </div>
    </form>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-content">{label}</p>
      {children}
    </div>
  );
}

function SkipDialog({
  posting,
  onClose,
  onDone,
}: {
  posting: PostingDetail;
  onClose: () => void;
  onDone: (next: PostingDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [reason, setReason] = useState('');
  const skip = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/postings/{postingId}/skip', {
          params: { path: { postingId: posting.id } },
          body: { reason: reason.trim() },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('ledger.unposted.skipTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="submit"
            form="ledger-skip"
            className={buttonClass.danger}
            disabled={reason.trim() === '' || skip.isPending}
          >
            {t('ledger.unposted.skip')}
          </button>
        </>
      }
    >
      <form
        id="ledger-skip"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim() !== '') {
            skip.mutate();
          }
        }}
      >
        <p>
          {posting.source.kind === 'invoice'
            ? t('ledger.unposted.skipInvoiceIntro')
            : t('ledger.unposted.skipIntro')}
        </p>
        <Field label={t('ledger.unposted.skipReason')}>
          {(id) => (
            <textarea
              id={id}
              required
              rows={2}
              maxLength={500}
              dir="auto"
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {skip.isError ? <LedgerFailure error={skip.error} /> : null}
      </form>
    </Dialog>
  );
}
