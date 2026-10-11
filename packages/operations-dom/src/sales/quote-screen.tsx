import { formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type QuoteDetail, useOperations } from '../api.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  copyText,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
} from '../ui.js';
import {
  DocumentLinesTable,
  QuoteStatusBadge,
  type SalesLineDraft,
  salesLineBodiesOf,
  salesLineDraftsOf,
  salesLineValid,
  SalesLinesEditor,
} from './sales-parts.js';
import { QuoteDocument } from './quote-document.js';

/**
 * One quote (CRM/ERP plan, phase S1; ADR-0006): its lines and totals, who it
 * was issued to and when, the customer's answer, and — for those who may —
 * editing the draft, issuing it (which hands over the customer's link, once),
 * recording the answer, revising, withdrawing and converting it to an order.
 */
export function QuoteScreen({ quoteId }: { quoteId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const [lines, setLines] = useState<SalesLineDraft[] | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [link, setLink] = useState<{ url: string | null; token: string } | null>(null);
  const [answering, setAnswering] = useState(false);

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const detail = useQuery({
    queryKey: keys.quote(quoteId),
    queryFn: async () =>
      (await client.GET('/v1/sales/quotes/{quoteId}', { params: { path: { quoteId } } })).data!,
  });

  const settle = async (next: QuoteDetail) => {
    queries.setQueryData(keys.quote(quoteId), next);
    await queries.invalidateQueries({ queryKey: ['sales'] });
    await queries.invalidateQueries({ queryKey: ['crm'] });
  };
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (
        await client.PATCH('/v1/sales/quotes/{quoteId}', {
          params: { path: { quoteId } },
          body: { expectedVersion: detail.data!.quote.version, ...body },
        })
      ).data!,
    onSuccess: async (next) => {
      setLines(null);
      setDetails(null);
      await settle(next);
    },
  });
  const issue = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/quotes/{quoteId}/issue', {
          params: { path: { quoteId } },
          body: { expectedVersion: detail.data!.quote.version },
        })
      ).data!,
    onSuccess: async ({ acceptToken, acceptUrl, ...next }) => {
      setLink({ url: acceptUrl, token: acceptToken });
      await settle(next);
    },
  });
  const convert = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/quotes/{quoteId}/convert', {
          params: { path: { quoteId } },
          body: { expectedVersion: detail.data!.quote.version },
        })
      ).data!,
    onSuccess: async (order) => {
      await queries.invalidateQueries({ queryKey: ['sales'] });
      await queries.invalidateQueries({ queryKey: ['crm'] });
      navigate(paths.salesOrder(order.order.id));
    },
  });
  const act = useMutation({
    mutationFn: async (action: 'revise' | 'cancel') =>
      (
        await client.POST(
          action === 'revise'
            ? '/v1/sales/quotes/{quoteId}/revise'
            : '/v1/sales/quotes/{quoteId}/cancel',
          {
            params: { path: { quoteId } },
            body: { expectedVersion: detail.data!.quote.version },
          },
        )
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.quotes} label={t('sales.quotes.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { quote, can } = detail.data;
  const editing = lines !== null;
  const error = [save.error, issue.error, act.error, convert.error].find(
    (candidate) => candidate !== null,
  );
  const totals = quote.totals;
  const printable = {
    company: { name: me.data?.company.name ?? '', logoUrl: null },
    reference: quote.reference,
    title: quote.title,
    issuedAt: quote.issuedAt,
    validUntil: quote.validUntil,
    customerName: quote.issuedTo?.customerName ?? quote.customer.name,
    customerAddress: quote.issuedTo?.customerAddress ?? null,
    contactName: quote.issuedTo?.contactName ?? quote.contact?.name ?? null,
    introduction: quote.introduction,
    terms: quote.terms,
    currencyCode: quote.currencyCode,
    lines: detail.data.lines,
    totals,
    answer:
      quote.answer === null
        ? null
        : { status: quote.answer.status, at: quote.answer.at, name: quote.answer.name },
  };

  return (
    <>
      <div aria-hidden="true" className="hidden print:block">
        <QuoteDocument document={printable} locale={locale} />
      </div>
      <div className="flex flex-col gap-6 text-start print:hidden">
        {back}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
              <span dir="ltr">{quote.reference}</span>
              <QuoteStatusBadge status={quote.status} expired={quote.expired} />
            </h1>
            <p className="text-lg text-content">{quote.title}</p>
            <p className="text-sm text-content-muted">
              <a
                href={paths.customer(quote.customer.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.customer(quote.customer.id));
                }}
              >
                {quote.customer.name}
              </a>
              {' · '}
              {t('sales.quotes.createdOn', { date: formatDateTime(quote.createdAt, { locale }) })}
              {quote.issuedAt === null || quote.issuedBy === null
                ? null
                : ` · ${t('sales.quotes.issuedLine', {
                    name: quote.issuedBy.name,
                    date: formatDateTime(quote.issuedAt, { locale }),
                  })}`}
            </p>
            {quote.status === 'draft' ? (
              <p className="text-sm text-content-muted">{t('sales.quotes.draftHint')}</p>
            ) : null}
            {quote.expired ? (
              <p role="status" className="text-sm text-danger">
                {t('sales.quotes.expiredHint')}
              </p>
            ) : null}
          </div>
          {editing || details !== null ? null : (
            <div className="flex flex-wrap gap-2">
              {can.issue ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={issue.isPending}
                  onClick={() => {
                    if (window.confirm(t('sales.quotes.issueConfirm'))) {
                      issue.mutate();
                    }
                  }}
                >
                  {issue.isPending ? t('sales.quotes.issuing') : t('sales.quotes.issue')}
                </button>
              ) : null}
              {can.answer ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => setAnswering(true)}
                >
                  {t('sales.quotes.answer')}
                </button>
              ) : null}
              {can.convert ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={convert.isPending}
                  onClick={() => convert.mutate()}
                >
                  {convert.isPending ? t('sales.quotes.converting') : t('sales.quotes.convert')}
                </button>
              ) : null}
              {quote.convertedOrderId === null ? null : (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => navigate(paths.salesOrder(quote.convertedOrderId!))}
                >
                  {t('sales.quotes.viewOrder')}
                </button>
              )}
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => window.print()}
              >
                {t('sales.quotes.print')}
              </button>
              {can.edit ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setLines(salesLineDraftsOf(detail.data.lines));
                  }}
                >
                  {t('sales.quotes.editLines')}
                </button>
              ) : null}
              {can.edit ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setDetails(detailsOf(detail.data));
                  }}
                >
                  {t('sales.quotes.editDetails')}
                </button>
              ) : null}
              {can.revise ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={act.isPending}
                  onClick={() => {
                    if (window.confirm(t('sales.quotes.reviseConfirm'))) {
                      act.mutate('revise');
                    }
                  }}
                >
                  {t('sales.quotes.revise')}
                </button>
              ) : null}
              {can.cancel ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={act.isPending}
                  onClick={() => {
                    if (window.confirm(t('sales.quotes.cancelConfirm'))) {
                      act.mutate('cancel');
                    }
                  }}
                >
                  {t('sales.quotes.withdraw')}
                </button>
              ) : null}
            </div>
          )}
        </header>

        {error === undefined ? null : <Failure error={error} />}

        {details === null ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('sales.quotes.validUntil')}</dt>
              <dd className="text-content">
                {quote.validUntil === null
                  ? t('sales.quotes.none')
                  : formatDate(quote.validUntil, { locale })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('sales.quotes.site')}</dt>
              <dd className="text-content">{quote.site?.name ?? t('sales.quotes.none')}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('sales.quotes.contact')}</dt>
              <dd className="text-content">{quote.contact?.name ?? t('sales.quotes.none')}</dd>
            </div>
            {quote.opportunity === null ? null : (
              <div className="flex flex-col">
                <dt className="text-content-muted">{t('sales.quotes.opportunity')}</dt>
                <dd>
                  <a
                    href={paths.crmOpportunity(quote.opportunity.id)}
                    className="text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.crmOpportunity(quote.opportunity!.id));
                    }}
                  >
                    {quote.opportunity.title}
                  </a>
                </dd>
              </div>
            )}
            {quote.introduction === null ? null : (
              <div className="flex flex-col sm:col-span-3">
                <dt className="text-content-muted">{t('sales.quotes.introduction')}</dt>
                <dd className="whitespace-pre-wrap text-content">{quote.introduction}</dd>
              </div>
            )}
            {quote.terms === null ? null : (
              <div className="flex flex-col sm:col-span-3">
                <dt className="text-content-muted">{t('sales.quotes.terms')}</dt>
                <dd className="whitespace-pre-wrap text-content">{quote.terms}</dd>
              </div>
            )}
            {quote.internalNotes === null ? null : (
              <div className="flex flex-col sm:col-span-3">
                <dt className="text-content-muted">{t('sales.quotes.internalNotes')}</dt>
                <dd className="whitespace-pre-wrap text-content">{quote.internalNotes}</dd>
              </div>
            )}
          </dl>
        ) : (
          <form
            aria-label={t('sales.quotes.editDetails')}
            className={`${cardClass} gap-3`}
            onSubmit={(event) => {
              event.preventDefault();
              if (details.title.trim() !== '') {
                save.mutate({
                  title: details.title.trim(),
                  validUntil: details.validUntil === '' ? null : details.validUntil,
                  introduction: details.introduction,
                  terms: details.terms,
                  internalNotes: details.internalNotes,
                });
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sales.quotes.fields.title')}>
                {(id) => (
                  <input
                    id={id}
                    required
                    maxLength={200}
                    className={inputClass}
                    value={details.title}
                    onChange={(event) => setDetails({ ...details, title: event.target.value })}
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
                    value={details.validUntil}
                    onChange={(event) => setDetails({ ...details, validUntil: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('sales.quotes.introduction')} className="sm:col-span-2">
                {(id) => (
                  <textarea
                    id={id}
                    rows={3}
                    maxLength={4000}
                    className={inputClass}
                    value={details.introduction}
                    onChange={(event) =>
                      setDetails({ ...details, introduction: event.target.value })
                    }
                  />
                )}
              </Field>
              <Field label={t('sales.quotes.terms')} className="sm:col-span-2">
                {(id) => (
                  <textarea
                    id={id}
                    rows={4}
                    maxLength={10_000}
                    className={inputClass}
                    value={details.terms}
                    onChange={(event) => setDetails({ ...details, terms: event.target.value })}
                  />
                )}
              </Field>
              <Field
                label={t('sales.quotes.internalNotes')}
                hint={t('sales.quotes.internalNotesHint')}
                className="sm:col-span-2"
              >
                {(id, describedBy) => (
                  <textarea
                    id={id}
                    rows={3}
                    maxLength={10_000}
                    aria-describedby={describedBy}
                    className={inputClass}
                    value={details.internalNotes}
                    onChange={(event) =>
                      setDetails({ ...details, internalNotes: event.target.value })
                    }
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setDetails(null)}
              >
                {t('sales.quotes.cancel')}
              </button>
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={details.title.trim() === '' || save.isPending}
              >
                {save.isPending ? t('sales.quotes.saving') : t('sales.quotes.save')}
              </button>
            </div>
          </form>
        )}

        <section aria-labelledby="sales-quote-lines" className={cardClass}>
          <h2 id="sales-quote-lines" className="text-base font-semibold text-content">
            {t('sales.quotes.lines')}
          </h2>
          {editing ? (
            <form
              aria-label={t('sales.quotes.editLines')}
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (lines.every(salesLineValid)) {
                  save.mutate({ lines: salesLineBodiesOf(lines) });
                }
              }}
            >
              <SalesLinesEditor lines={lines} onChange={setLines} />
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setLines(null)}
                >
                  {t('sales.quotes.cancel')}
                </button>
                <button
                  type="submit"
                  className={buttonClass.primary}
                  disabled={!lines.every(salesLineValid) || save.isPending}
                >
                  {save.isPending ? t('sales.quotes.saving') : t('sales.quotes.save')}
                </button>
              </div>
            </form>
          ) : detail.data.lines.length === 0 ? (
            <p className="text-sm text-content-muted">{t('sales.quotes.noLines')}</p>
          ) : (
            <DocumentLinesTable
              lines={detail.data.lines}
              totals={totals}
              currency={quote.currencyCode}
            />
          )}
        </section>

        {quote.issuedTo === null ? null : (
          <section aria-labelledby="sales-quote-issued" className={cardClass}>
            <h2 id="sales-quote-issued" className="text-base font-semibold text-content">
              {t('sales.quotes.issuedTo')}
            </h2>
            <p className="text-sm text-content">
              {quote.issuedTo.customerName}
              {quote.issuedTo.contactName === null ? null : ` · ${quote.issuedTo.contactName}`}
              {quote.issuedTo.contactEmail === null ? null : (
                <span dir="ltr"> · {quote.issuedTo.contactEmail}</span>
              )}
            </p>
            <p className="text-sm text-content-muted">
              {quote.hasLink ? t('sales.quotes.linkLive') : t('sales.quotes.noLink')}
            </p>
            {quote.answer === null ? null : (
              <p className="text-sm text-content">
                {t(`sales.quotes.answered.${quote.answer.status}`, {
                  date: formatDateTime(quote.answer.at, { locale }),
                })}{' '}
                {quote.answer.via === 'link'
                  ? t('sales.quotes.via.link')
                  : t('sales.quotes.via.office', { name: quote.answer.by?.name ?? '—' })}
                {quote.answer.name === null ? null : ` · ${quote.answer.name}`}
                {quote.answer.reason === null ? null : ` · ${quote.answer.reason}`}
              </p>
            )}
          </section>
        )}

        {link === null ? null : (
          <Dialog
            title={t('sales.quotes.linkTitle')}
            onClose={() => setLink(null)}
            footer={
              <button type="button" className={buttonClass.primary} onClick={() => setLink(null)}>
                {t('sales.quotes.done')}
              </button>
            }
          >
            <div className="flex flex-col gap-3">
              <p className="text-sm text-content">{t('sales.quotes.linkIntro')}</p>
              <output
                dir="ltr"
                className="block break-all rounded-md border border-border-subtle p-2 text-sm"
              >
                {link.url ?? `/q/${link.token}`}
              </output>
              <button
                type="button"
                className={`${buttonClass.secondary} self-start`}
                onClick={() => copyText(link.url ?? `/q/${link.token}`)}
              >
                {t('sales.quotes.copyLink')}
              </button>
            </div>
          </Dialog>
        )}
        {answering ? (
          <AnswerDialog
            detail={detail.data}
            onClose={() => setAnswering(false)}
            onDone={async (next) => {
              setAnswering(false);
              await settle(next);
            }}
          />
        ) : null}
      </div>
    </>
  );
}

interface Details {
  title: string;
  validUntil: string;
  introduction: string;
  terms: string;
  internalNotes: string;
}

function detailsOf(detail: QuoteDetail): Details {
  return {
    title: detail.quote.title,
    validUntil: detail.quote.validUntil ?? '',
    introduction: detail.quote.introduction ?? '',
    terms: detail.quote.terms ?? '',
    internalNotes: detail.quote.internalNotes ?? '',
  };
}

function AnswerDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: QuoteDetail;
  onClose: () => void;
  onDone: (next: QuoteDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [status, setStatus] = useState<'accepted' | 'rejected'>('accepted');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const answer = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/quotes/{quoteId}/answer', {
          params: { path: { quoteId: detail.quote.id } },
          body: {
            expectedVersion: detail.quote.version,
            status,
            ...(name.trim() === '' ? {} : { name: name.trim() }),
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('sales.quotes.answerTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('sales.quotes.cancel')}
          </button>
          <button
            type="submit"
            form="sales-answer"
            className={buttonClass.primary}
            disabled={answer.isPending}
          >
            {answer.isPending ? t('sales.quotes.recording') : t('sales.quotes.record')}
          </button>
        </>
      }
    >
      <form
        id="sales-answer"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          answer.mutate();
        }}
      >
        <Field label={t('sales.quotes.answerStatus')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as 'accepted' | 'rejected')}
            >
              <option value="accepted">{t('sales.status.accepted')}</option>
              <option value="rejected">{t('sales.status.rejected')}</option>
            </select>
          )}
        </Field>
        <Field label={t('sales.quotes.answerName')} hint={t('sales.quotes.answerNameHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              maxLength={200}
              aria-describedby={describedBy}
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {status === 'rejected' ? (
          <Field label={t('sales.quotes.answerReason')}>
            {(id) => (
              <input
                id={id}
                maxLength={1000}
                className={inputClass}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
        ) : null}
        {answer.isError ? <Failure error={answer.error} /> : null}
      </form>
    </Dialog>
  );
}
