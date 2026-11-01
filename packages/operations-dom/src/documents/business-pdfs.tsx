import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Dialog, Failure, Field, inputClass } from '../ui.js';
import {
  DocumentMarks,
  DocumentStateBadge,
  documentState,
  failureKey,
  useDocumentAccess,
} from './document-parts.js';

/**
 * A record's PDFs (1.3.0, decision 11): the quote, invoice, purchase order or
 * job report printed by the server in the company's look, kept in the
 * documents register. Shown on the record's own screen beside the browser's
 * Print, which stays as it was.
 *
 * The server says what this seat may do with them; a seat that may not see
 * them, or a company without the documents module, sees nothing here.
 */

export type BusinessPdfKind = 'quote' | 'invoice' | 'purchase_order' | 'job_report';

/** The record's PDFs and what this seat may do, polled while one is being made. */
function useBusinessPdfs(kind: BusinessPdfKind, recordId: string, enabled: boolean) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.businessPdfs(kind, recordId),
    enabled,
    retry: false,
    queryFn: async () =>
      (
        await client.GET('/v1/business-documents', {
          params: { query: { kind, recordId } },
        })
      ).data!,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'pending') === true ? 2000 : false,
  });
}

export function BusinessPdfPanel({
  kind,
  recordId,
  className = '',
}: {
  kind: BusinessPdfKind;
  recordId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const access = useDocumentAccess();
  const [making, setMaking] = useState(false);
  const [emailing, setEmailing] = useState<string | null>(null);

  const list = useBusinessPdfs(kind, recordId, access.enabled);
  const open = async (documentId: string, disposition: 'inline' | 'attachment') => {
    const { data } = await client.GET('/v1/business-documents/{documentId}/file', {
      params: { path: { documentId }, query: { disposition } },
    });
    if (data !== undefined) {
      window.open(data.url, '_blank', 'noopener');
    }
  };

  if (!access.enabled || list.data === undefined) {
    // Loading, refused (no permission, module off) or not yet known: nothing to offer.
    return null;
  }
  const { items, can } = list.data;
  const shown = items.slice(0, 5);
  const emailingDocument = items.find((item) => item.id === emailing);

  return (
    <section
      aria-labelledby={`business-pdfs-${recordId}`}
      className={`${cardClass} print:hidden ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`business-pdfs-${recordId}`} className="text-base font-semibold text-content">
            {t('businessPdfs.panel.title')}
          </h2>
          <p className="text-sm text-content-muted">{t('businessPdfs.panel.intro')}</p>
        </div>
        {can.make ? (
          <button type="button" className={buttonClass.secondary} onClick={() => setMaking(true)}>
            {t('businessPdfs.panel.make')}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-content-muted">{t('businessPdfs.panel.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {shown.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-content">
                  <span dir="auto">{item.title}</span>
                  <DocumentStateBadge state={documentState(item)} />
                  <DocumentMarks document={item} />
                </p>
                <p className="text-xs text-content-muted">
                  {t('businessPdfs.panel.made', {
                    date: formatDateTime(item.createdAt, { locale }),
                    name: item.createdBy.name,
                  })}
                  {item.status === 'ready'
                    ? ` · ${item.shareable ? t('businessPdfs.panel.shared') : t('businessPdfs.panel.notShared')}`
                    : null}
                </p>
                {item.status === 'failed' ? (
                  <p role="alert" className="text-xs text-danger">
                    {t(failureKey(item.failureCode))}
                  </p>
                ) : null}
              </div>
              {item.status === 'ready' ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => void open(item.id, 'inline')}
                  >
                    {t('businessPdfs.panel.view')}
                  </button>
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => void open(item.id, 'attachment')}
                  >
                    {t('businessPdfs.panel.download')}
                  </button>
                  {can.email ? (
                    <button
                      type="button"
                      className={buttonClass.secondary}
                      onClick={() => setEmailing(item.id)}
                    >
                      {t('businessPdfs.panel.email')}
                    </button>
                  ) : null}
                </div>
              ) : item.status === 'pending' ? (
                <span role="status" className="text-xs text-content-muted">
                  {t('businessPdfs.panel.pending')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {making ? (
        <MakePdfDialog kind={kind} recordId={recordId} onClose={() => setMaking(false)} />
      ) : null}
      {emailingDocument === undefined ? null : (
        <EmailPdfDialog
          documentId={emailingDocument.id}
          title={emailingDocument.title}
          to={list.data.email ?? ''}
          onClose={() => setEmailing(null)}
        />
      )}
    </section>
  );
}

/**
 * Asking for a PDF: its language and, for someone who may share documents,
 * whether its QR code opens it at once. A quote made from the link the issue
 * step handed over prints that link instead (`quoteLinkToken`).
 */
export function MakePdfDialog({
  kind,
  recordId,
  quoteLinkToken,
  onClose,
}: {
  kind: BusinessPdfKind;
  recordId: string;
  quoteLinkToken?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const list = useBusinessPdfs(kind, recordId, true);
  const canShare = list.data?.can.share === true;
  const [picked, setChosen] = useState<'en' | 'ar' | null>(null);
  const chosen = picked ?? list.data?.language ?? 'en';
  const [shareable, setShareable] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const make = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/business-documents', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            kind,
            recordId,
            language: chosen,
            shareable,
            ...(quoteLinkToken === undefined ? {} : { quoteLinkToken }),
          },
        })
      ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: keys.businessPdfs(kind, recordId) });
      await queries.invalidateQueries({ queryKey: ['documents'] });
      onClose();
    },
  });
  return (
    <Dialog
      title={t('businessPdfs.make.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form={`make-pdf-${recordId}`}
            className={buttonClass.primary}
            disabled={make.isPending}
            aria-busy={make.isPending}
          >
            {make.isPending ? t('businessPdfs.panel.making') : t('businessPdfs.make.submit')}
          </button>
        </>
      }
    >
      <form
        id={`make-pdf-${recordId}`}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          make.mutate();
        }}
      >
        <Field label={t('businessPdfs.make.language')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={chosen}
              onChange={(event) => setChosen(event.target.value === 'ar' ? 'ar' : 'en')}
            >
              <option value="en">{t('businessPdfs.make.english')}</option>
              <option value="ar">{t('businessPdfs.make.arabic')}</option>
            </select>
          )}
        </Field>
        {kind === 'quote' ? (
          <p className="text-sm text-content-muted">
            {quoteLinkToken === undefined
              ? t('businessPdfs.make.quoteNoLinkHint')
              : t('businessPdfs.make.quoteLinkHint')}
          </p>
        ) : null}
        {canShare ? (
          <div className="flex flex-col gap-0.5">
            <label className="flex items-start gap-2 text-sm text-content">
              <input
                type="checkbox"
                className="mt-1"
                checked={shareable}
                onChange={(event) => setShareable(event.target.checked)}
              />
              {t('businessPdfs.make.share')}
            </label>
            <p className="ps-6 text-xs text-content-muted">{t('businessPdfs.make.shareHint')}</p>
          </div>
        ) : null}
        {make.isError ? <Failure error={make.error} /> : null}
      </form>
    </Dialog>
  );
}

function EmailPdfDialog({
  documentId,
  title,
  to: initial,
  onClose,
}: {
  documentId: string;
  title: string;
  to: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [to, setTo] = useState(initial);
  const [message, setMessage] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const send = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/business-documents/{documentId}/email', {
          params: { path: { documentId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { to: to.trim(), ...(message.trim() === '' ? {} : { message: message.trim() }) },
        })
      ).data!,
  });
  const result = send.data;
  return (
    <Dialog
      title={t('businessPdfs.email.title')}
      onClose={onClose}
      footer={
        result?.sent === true ? (
          <button type="button" className={buttonClass.primary} onClick={onClose}>
            {t('common.close')}
          </button>
        ) : (
          <>
            <button type="button" className={buttonClass.secondary} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              form={`email-pdf-${documentId}`}
              className={buttonClass.primary}
              disabled={send.isPending || to.trim() === ''}
              aria-busy={send.isPending}
            >
              {send.isPending ? t('businessPdfs.email.sending') : t('businessPdfs.email.send')}
            </button>
          </>
        )
      }
    >
      <form
        id={`email-pdf-${documentId}`}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate();
        }}
      >
        <p dir="auto" className="text-sm font-medium text-content">
          {title}
        </p>
        <Field label={t('businessPdfs.email.to')} hint={t('businessPdfs.email.toHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="email"
              dir="ltr"
              required
              maxLength={254}
              aria-describedby={describedBy}
              className={inputClass}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('businessPdfs.email.message')}>
          {(id) => (
            <textarea
              id={id}
              rows={3}
              maxLength={2000}
              className={inputClass}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          )}
        </Field>
        {result === undefined ? null : result.sent ? (
          <p role="status" className="text-sm text-success">
            {t('businessPdfs.email.sent', { email: to.trim() })}
          </p>
        ) : (
          <p role="alert" className="text-sm text-danger">
            {t('businessPdfs.email.notSent', { problem: result.problem ?? '' })}
          </p>
        )}
        {send.isError ? <Failure error={send.error} /> : null}
      </form>
    </Dialog>
  );
}
