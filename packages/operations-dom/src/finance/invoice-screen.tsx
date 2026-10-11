import { formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type CreditNoteRow, type InvoiceDetail, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import {
  DocumentLinesTable,
  type SalesLineDraft,
  salesLineBodiesOf,
  salesLineDraftsOf,
  salesLineValid,
  SalesLinesEditor,
} from '../sales/sales-parts.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
} from '../ui.js';
import {
  AmountsSummary,
  InvoiceStatusBadge,
  RecordPaymentDialog,
  useFinanceAccess,
} from './finance-parts.js';
import { InvoiceDocument } from './invoice-document.js';

/**
 * One invoice (CRM/ERP plan, phase B1; ADR-0007): what it bills, what it adds
 * up to and what is left, the credit notes and payments against it, and —
 * for those who may — editing the draft, issuing it, voiding it while
 * nothing is paid or credited, crediting it, recording a payment and
 * printing it.
 */
export function InvoiceScreen({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useFinanceAccess();
  const [lines, setLines] = useState<SalesLineDraft[] | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [dialog, setDialog] = useState<'issue' | 'void' | 'credit' | 'pay' | null>(null);

  const detail = useQuery({
    queryKey: keys.invoice(invoiceId),
    queryFn: async () =>
      (await client.GET('/v1/finance/invoices/{invoiceId}', { params: { path: { invoiceId } } }))
        .data!,
  });

  const settle = async (next?: InvoiceDetail) => {
    if (next !== undefined) {
      queries.setQueryData(keys.invoice(invoiceId), next);
    }
    await queries.invalidateQueries({ queryKey: ['finance'] });
  };
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (
        await client.PATCH('/v1/finance/invoices/{invoiceId}', {
          params: { path: { invoiceId } },
          body: { expectedVersion: detail.data!.invoice.version, ...body },
        })
      ).data!,
    onSuccess: async (next) => {
      setLines(null);
      setDetails(null);
      await settle(next);
    },
  });
  const discard = useMutation({
    mutationFn: async () =>
      client.POST('/v1/finance/invoices/{invoiceId}/discard', {
        params: { path: { invoiceId } },
        body: { expectedVersion: detail.data!.invoice.version },
      }),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['finance'] });
      navigate(paths.invoices);
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.invoices} label={t('finance.invoices.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { invoice, can, creditNotes, payments } = detail.data;
  const editing = lines !== null || details !== null;
  const error = [save.error, discard.error].find((candidate) => candidate !== null);
  const title = invoice.reference ?? t('finance.invoices.draftLabel');
  const sourceLines = new Map(detail.data.lines.map((line) => [line.id, line]));
  const printable = {
    reference: invoice.reference,
    status: invoice.status,
    issuer: invoice.issuer ?? {
      name: '',
      address: null,
      taxReference: null,
      paymentInstructions: null,
      footer: null,
    },
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    billedTo: {
      customerName: invoice.billedTo?.customerName ?? invoice.customer.name,
      customerAddress: invoice.billedTo?.customerAddress ?? null,
      contactName: invoice.billedTo?.contactName ?? invoice.contact?.name ?? null,
    },
    notes: invoice.notes,
    currencyCode: invoice.currencyCode,
    lines: detail.data.lines,
    totals: invoice.totals,
    amounts: invoice.amounts,
  };

  return (
    <>
      <div aria-hidden="true" className="hidden print:block">
        <InvoiceDocument document={printable} locale={locale} />
      </div>
      <div className="flex flex-col gap-6 text-start print:hidden">
        {back}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
              <span dir="ltr">{title}</span>
              <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
            </h1>
            <p className="text-sm text-content-muted">
              <a
                href={paths.customer(invoice.customer.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.customer(invoice.customer.id));
                }}
              >
                {invoice.customer.name}
              </a>
              {invoice.source === null ? null : (
                <>
                  {' · '}
                  <a
                    href={
                      invoice.source.kind === 'sales_order'
                        ? paths.salesOrder(invoice.source.id)
                        : paths.workOrder(invoice.source.id)
                    }
                    dir="ltr"
                    className="text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(
                        invoice.source!.kind === 'sales_order'
                          ? paths.salesOrder(invoice.source!.id)
                          : paths.workOrder(invoice.source!.id),
                      );
                    }}
                  >
                    {t('finance.invoices.from', { reference: invoice.source.reference })}
                  </a>
                </>
              )}
              {invoice.issuedAt === null || invoice.issuedBy === null
                ? null
                : ` · ${t('finance.invoices.issuedLine', {
                    name: invoice.issuedBy.name,
                    date: formatDateTime(invoice.issuedAt, { locale }),
                  })}`}
            </p>
            {invoice.status === 'draft' ? (
              <p className="text-sm text-content-muted">{t('finance.invoices.draftHint')}</p>
            ) : null}
            {invoice.voidedAt === null ? null : (
              <p className="text-sm text-content-muted">
                {t('finance.invoices.voidedLine', {
                  date: formatDateTime(invoice.voidedAt, { locale }),
                  reason: invoice.voidReason ?? '',
                })}
              </p>
            )}
          </div>
          {editing ? null : (
            <div className="flex flex-wrap gap-2">
              {can.issue ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => setDialog('issue')}
                >
                  {t('finance.invoices.issue')}
                </button>
              ) : null}
              {can.recordPayment ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => setDialog('pay')}
                >
                  {t('finance.payments.record')}
                </button>
              ) : null}
              {can.credit ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setDialog('credit')}
                >
                  {t('finance.credit.new')}
                </button>
              ) : null}
              {can.edit ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setLines(salesLineDraftsOf(detail.data.lines));
                  }}
                >
                  {t('finance.invoices.editLines')}
                </button>
              ) : null}
              {can.edit ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setDetails({
                      dueDate: invoice.dueDate ?? '',
                      notes: invoice.notes ?? '',
                      internalNotes: invoice.internalNotes ?? '',
                    });
                  }}
                >
                  {t('finance.invoices.editDetails')}
                </button>
              ) : null}
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => window.print()}
              >
                {t('finance.print')}
              </button>
              {can.void ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setDialog('void')}
                >
                  {t('finance.invoices.void')}
                </button>
              ) : null}
              {can.discard ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={discard.isPending}
                  onClick={() => {
                    if (window.confirm(t('finance.invoices.discardConfirm'))) {
                      discard.mutate();
                    }
                  }}
                >
                  {t('finance.invoices.discard')}
                </button>
              ) : null}
            </div>
          )}
        </header>

        {error === undefined ? null : <Failure error={error} />}

        <section aria-labelledby="finance-invoice-amounts" className={cardClass}>
          <h2 id="finance-invoice-amounts" className="sr-only">
            {t('finance.amounts.title')}
          </h2>
          <AmountsSummary amounts={invoice.amounts} currency={invoice.currencyCode} />
        </section>

        {details === null ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('finance.invoices.issueDate')}</dt>
              <dd className="text-content">
                {invoice.issueDate === null
                  ? t('finance.none')
                  : formatDate(invoice.issueDate, { locale })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('finance.invoices.dueDate')}</dt>
              <dd className="text-content">
                {invoice.dueDate === null
                  ? t('finance.invoices.dueByDefault')
                  : formatDate(invoice.dueDate, { locale })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('finance.invoices.site')}</dt>
              <dd className="text-content">{invoice.site?.name ?? t('finance.none')}</dd>
            </div>
            {invoice.notes === null ? null : (
              <div className="flex flex-col sm:col-span-3">
                <dt className="text-content-muted">{t('finance.invoices.notes')}</dt>
                <dd dir="auto" className="whitespace-pre-wrap text-content">
                  {invoice.notes}
                </dd>
              </div>
            )}
            {invoice.internalNotes === null ? null : (
              <div className="flex flex-col sm:col-span-3">
                <dt className="text-content-muted">{t('finance.invoices.internalNotes')}</dt>
                <dd dir="auto" className="whitespace-pre-wrap text-content">
                  {invoice.internalNotes}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <form
            className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate({
                dueDate: details.dueDate === '' ? null : details.dueDate,
                notes: details.notes.trim() === '' ? null : details.notes.trim(),
                internalNotes:
                  details.internalNotes.trim() === '' ? null : details.internalNotes.trim(),
              });
            }}
          >
            <Field label={t('finance.invoices.dueDate')} hint={t('finance.invoices.dueDateHint')}>
              {(id, describedBy) => (
                <input
                  id={id}
                  type="date"
                  dir="ltr"
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={details.dueDate}
                  onChange={(event) => setDetails({ ...details, dueDate: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('finance.invoices.notes')} hint={t('finance.invoices.notesHint')}>
              {(id, describedBy) => (
                <textarea
                  id={id}
                  rows={3}
                  aria-describedby={describedBy}
                  maxLength={10_000}
                  className={inputClass}
                  value={details.notes}
                  onChange={(event) => setDetails({ ...details, notes: event.target.value })}
                />
              )}
            </Field>
            <Field
              label={t('finance.invoices.internalNotes')}
              hint={t('sales.quotes.internalNotesHint')}
            >
              {(id, describedBy) => (
                <textarea
                  id={id}
                  rows={3}
                  aria-describedby={describedBy}
                  maxLength={10_000}
                  className={inputClass}
                  value={details.internalNotes}
                  onChange={(event) =>
                    setDetails({ ...details, internalNotes: event.target.value })
                  }
                />
              )}
            </Field>
            <div className="flex gap-2">
              <button type="submit" className={buttonClass.primary} disabled={save.isPending}>
                {save.isPending ? t('finance.saving') : t('finance.save')}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setDetails(null)}
              >
                {t('finance.cancel')}
              </button>
            </div>
          </form>
        )}

        <section aria-labelledby="finance-invoice-lines" className={cardClass}>
          <h2 id="finance-invoice-lines" className="text-base font-semibold text-content">
            {t('finance.invoices.lines')}
          </h2>
          {lines === null ? (
            detail.data.lines.length === 0 ? (
              <p className="text-sm text-content-muted">{t('sales.quotes.noLines')}</p>
            ) : (
              <DocumentLinesTable
                lines={detail.data.lines}
                totals={invoice.totals}
                currency={invoice.currencyCode}
              />
            )
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (lines.every(salesLineValid)) {
                  const bodies = salesLineBodiesOf(lines);
                  save.mutate({
                    lines: bodies.map((body, index) => {
                      const original = sourceLines.get(lines[index]!.key);
                      return {
                        ...body,
                        ...(original?.salesOrderLineId == null
                          ? {}
                          : { salesOrderLineId: original.salesOrderLineId }),
                        ...(original?.workOrderMaterialId == null
                          ? {}
                          : { workOrderMaterialId: original.workOrderMaterialId }),
                      };
                    }),
                  });
                }
              }}
            >
              <SalesLinesEditor lines={lines} onChange={setLines} />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className={buttonClass.primary}
                  disabled={save.isPending || !lines.every(salesLineValid)}
                >
                  {save.isPending ? t('finance.saving') : t('finance.save')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setLines(null)}
                >
                  {t('finance.cancel')}
                </button>
              </div>
            </form>
          )}
        </section>

        {creditNotes.length === 0 ? null : (
          <section aria-labelledby="finance-invoice-credits" className={cardClass}>
            <h2 id="finance-invoice-credits" className="text-base font-semibold text-content">
              {t('finance.credit.title')}
            </h2>
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {creditNotes.map((note) => (
                <CreditNoteItem
                  key={note.id}
                  note={note}
                  canIssue={access.issue}
                  canDiscard={access.manage}
                  onChanged={() => settle()}
                />
              ))}
            </ul>
          </section>
        )}

        {payments.length === 0 ? null : (
          <section aria-labelledby="finance-invoice-payments" className={cardClass}>
            <h2 id="finance-invoice-payments" className="text-base font-semibold text-content">
              {t('finance.payments.title')}
            </h2>
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {payments.map((payment) => (
                <li
                  key={payment.allocationId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span>
                    <a
                      href={paths.payment(payment.receipt.id)}
                      dir="ltr"
                      className="text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.payment(payment.receipt.id));
                      }}
                    >
                      {payment.receipt.reference}
                    </a>
                    <span className="text-content-muted">
                      {' · '}
                      {formatDate(payment.receivedOn, { locale })} ·{' '}
                      {t(`finance.method.${payment.method}`)}
                    </span>
                  </span>
                  <span className="text-content tabular-nums">
                    {formatAmount(payment.amount, invoice.currencyCode, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {dialog === 'issue' ? (
          <IssueDialog detail={detail.data} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
        {dialog === 'void' ? (
          <VoidDialog detail={detail.data} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
        {dialog === 'credit' ? (
          <CreditDialog detail={detail.data} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
        {dialog === 'pay' ? (
          <RecordPaymentDialog
            customer={invoice.customer}
            invoice={{
              id: invoice.id,
              reference: invoice.reference,
              balance: invoice.amounts.balance,
              currencyCode: invoice.currencyCode,
            }}
            onClose={() => setDialog(null)}
            onDone={() => {
              setDialog(null);
              void settle();
            }}
          />
        ) : null}
      </div>
    </>
  );
}

interface Details {
  dueDate: string;
  notes: string;
  internalNotes: string;
}

function CreditNoteItem({
  note,
  canIssue,
  canDiscard,
  onChanged,
}: {
  note: CreditNoteRow;
  canIssue: boolean;
  canDiscard: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const act = useMutation({
    mutationFn: async (action: 'issue' | 'discard') => {
      const params = { path: { creditNoteId: note.id } };
      const body = { expectedVersion: note.version };
      return action === 'issue'
        ? client.POST('/v1/finance/credit-notes/{creditNoteId}/issue', { params, body })
        : client.POST('/v1/finance/credit-notes/{creditNoteId}/discard', { params, body });
    },
    onSuccess: onChanged,
  });
  const draft = note.status === 'draft';
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span dir="ltr" className="font-medium text-content">
            {note.reference ?? t('finance.credit.draftLabel')}
          </span>
          <span className="text-content-muted">{note.reason}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-content tabular-nums">
            −{formatAmount(note.total, note.currencyCode, locale)}
          </span>
          {draft && canIssue ? (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={act.isPending}
              onClick={() => {
                if (window.confirm(t('finance.credit.issueConfirm'))) {
                  act.mutate('issue');
                }
              }}
            >
              {t('finance.credit.issue')}
            </button>
          ) : null}
          {draft && canDiscard ? (
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={act.isPending}
              onClick={() => act.mutate('discard')}
            >
              {t('finance.credit.discard')}
            </button>
          ) : null}
        </span>
      </div>
      {act.isError ? <Failure error={act.error} /> : null}
    </li>
  );
}

function IssueDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: InvoiceDetail;
  onClose: () => void;
  onDone: (next: InvoiceDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [dueDate, setDueDate] = useState(detail.invoice.dueDate ?? '');
  const issue = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/invoices/{invoiceId}/issue', {
          params: { path: { invoiceId: detail.invoice.id } },
          body: { expectedVersion: detail.invoice.version, ...(dueDate === '' ? {} : { dueDate }) },
        })
      ).data!,
    onSuccess: async (next) => {
      onClose();
      await onDone(next);
    },
  });
  return (
    <Dialog
      title={t('finance.invoices.issueTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('finance.cancel')}
          </button>
          <button
            type="submit"
            form="finance-issue-invoice"
            className={buttonClass.primary}
            disabled={issue.isPending}
          >
            {issue.isPending ? t('finance.invoices.issuing') : t('finance.invoices.issue')}
          </button>
        </>
      }
    >
      <form
        id="finance-issue-invoice"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          issue.mutate();
        }}
      >
        <p className="text-sm text-content">{t('finance.invoices.issueIntro')}</p>
        <Field label={t('finance.invoices.dueDate')} hint={t('finance.invoices.dueDateHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              aria-describedby={describedBy}
              className={inputClass}
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          )}
        </Field>
        {issue.isError ? <Failure error={issue.error} /> : null}
      </form>
    </Dialog>
  );
}

function VoidDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: InvoiceDetail;
  onClose: () => void;
  onDone: (next: InvoiceDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [reason, setReason] = useState('');
  const voided = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/invoices/{invoiceId}/void', {
          params: { path: { invoiceId: detail.invoice.id } },
          body: { expectedVersion: detail.invoice.version, reason: reason.trim() },
        })
      ).data!,
    onSuccess: async (next) => {
      onClose();
      await onDone(next);
    },
  });
  return (
    <Dialog
      title={t('finance.invoices.voidTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('finance.cancel')}
          </button>
          <button
            type="submit"
            form="finance-void-invoice"
            className={buttonClass.primary}
            disabled={reason.trim() === '' || voided.isPending}
          >
            {t('finance.invoices.void')}
          </button>
        </>
      }
    >
      <form
        id="finance-void-invoice"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim() !== '') {
            voided.mutate();
          }
        }}
      >
        <p className="text-sm text-content">{t('finance.invoices.voidIntro')}</p>
        <Field label={t('finance.invoices.voidReason')}>
          {(id) => (
            <input
              id={id}
              required
              maxLength={1000}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {voided.isError ? <Failure error={voided.error} /> : null}
      </form>
    </Dialog>
  );
}

function CreditDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: InvoiceDetail;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [reason, setReason] = useState('');
  const [whole, setWhole] = useState(false);
  const [lines, setLines] = useState<SalesLineDraft[]>([]);
  const ready =
    reason.trim() !== '' && (whole || (lines.length > 0 && lines.every(salesLineValid)));
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/finance/invoices/{invoiceId}/credit-notes', {
          params: { path: { invoiceId: detail.invoice.id } },
          body: {
            reason: reason.trim(),
            whole,
            ...(whole ? {} : { lines: salesLineBodiesOf(lines) }),
          },
        })
      ).data!,
    onSuccess: async () => {
      onClose();
      await onDone();
    },
  });
  return (
    <Dialog
      title={t('finance.credit.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('finance.cancel')}
          </button>
          <button
            type="submit"
            form="finance-credit-note"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('finance.credit.creating') : t('finance.credit.create')}
          </button>
        </>
      }
    >
      <form
        id="finance-credit-note"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        <p className="text-sm text-content">{t('finance.credit.intro')}</p>
        <Field label={t('finance.credit.reason')}>
          {(id) => (
            <input
              id={id}
              required
              maxLength={1000}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={whole}
            onChange={(event) => setWhole(event.target.checked)}
          />
          {t('finance.credit.whole')}
        </label>
        {whole ? null : (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-content">
              {t('finance.credit.lines')}
            </legend>
            <SalesLinesEditor lines={lines} onChange={setLines} />
          </fieldset>
        )}
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}
