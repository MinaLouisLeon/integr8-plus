import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type EtaDocumentDetail, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
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
  EtaStateBadge,
  idempotencyKey,
  useEtaAccess,
  useEtaPdf,
  useLastErrorText,
} from './eta-parts.js';

/**
 * One ETA document (PLAN §3): where it stands, what the ETA said, every call
 * made about it, and the next step the reader may take — ask for a
 * signature, send it, check its status, resolve an unclear outcome, cancel
 * it at the ETA, or download the ETA's PDF. A document being sent or waiting
 * for the ETA refreshes itself.
 */
export function EtaDocumentScreen({ documentId }: { documentId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useEtaAccess();
  const lastError = useLastErrorText();
  const pdf = useEtaPdf();
  const [dialog, setDialog] = useState<'resolve' | 'cancel' | null>(null);

  const detail = useQuery({
    queryKey: keys.etaDocument(documentId),
    queryFn: async () =>
      (
        await client.GET('/v1/eta/documents/{documentId}', {
          params: { path: { documentId } },
        })
      ).data!,
    refetchInterval: (query) =>
      ['submitting', 'submitted', 'pending_signature'].includes(
        query.state.data?.document.state ?? '',
      )
        ? 5000
        : false,
  });

  const saved = (next: EtaDocumentDetail) => {
    queries.setQueryData(keys.etaDocument(documentId), next);
    void queries.invalidateQueries({ queryKey: ['eta', 'documents'] });
    void queries.invalidateQueries({ queryKey: ['eta', 'invoice'] });
  };
  const path = { params: { path: { documentId } } };
  const requestSignature = useMutation({
    mutationFn: async () =>
      (await client.POST('/v1/eta/documents/{documentId}/signature-request', path)).data!,
    onSuccess: saved,
  });
  const withdraw = useMutation({
    mutationFn: async (requestId: string) =>
      (
        await client.POST('/v1/eta/signing-requests/{requestId}/cancel', {
          params: { path: { requestId } },
        })
      ).data!,
    onSuccess: saved,
  });
  const submit = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/eta/documents/{documentId}/submit', {
          params: { path: { documentId }, header: { 'Idempotency-Key': idempotencyKey() } },
        })
      ).data!,
    onSuccess: saved,
  });
  const sync = useMutation({
    mutationFn: async () => (await client.POST('/v1/eta/documents/{documentId}/sync', path)).data!,
    onSuccess: saved,
  });
  const download = useMutation({ mutationFn: () => pdf(documentId) });

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return <Failure error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const { document, signingRequest, attempts } = detail.data;
  const failure =
    requestSignature.error ?? withdraw.error ?? submit.error ?? sync.error ?? download.error;
  const date = (value: string | null) => (value === null ? '—' : formatDateTime(value, { locale }));

  return (
    <div className="flex flex-col gap-6 text-start">
      <nav>
        <BackLink to={paths.eInvoicing} label={t('eta.back')} />
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-content">
            <span dir="ltr">{document.internalId}</span>
            <EtaStateBadge state={document.state} />
          </h1>
          <p className="text-sm text-content-muted">
            {t('eta.document.sequence', { sequence: document.sequence })} ·{' '}
            {t(`eta.environment.${document.environment}`)} ·{' '}
            {formatAmount(document.totalAmount, document.currencyCode, locale)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {access.submit && document.state === 'ready' ? (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={requestSignature.isPending}
              onClick={() => requestSignature.mutate()}
            >
              {t('eta.actions.requestSignature')}
            </button>
          ) : null}
          {access.submit && ['signed', 'failed'].includes(document.state) ? (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={submit.isPending}
              onClick={() => submit.mutate()}
            >
              {t('eta.actions.submit')}
            </button>
          ) : null}
          {access.submit && ['submitted', 'valid'].includes(document.state) ? (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              {t('eta.actions.sync')}
            </button>
          ) : null}
          {access.submit && document.state === 'unknown' ? (
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => setDialog('resolve')}
            >
              {t('eta.actions.resolve')}
            </button>
          ) : null}
          {document.etaUuid !== null &&
          ['submitted', 'valid', 'invalid', 'cancelled'].includes(document.state) ? (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={download.isPending}
              onClick={() => download.mutate()}
            >
              {t('eta.actions.pdf')}
            </button>
          ) : null}
          {access.submit && document.state === 'valid' ? (
            <button
              type="button"
              className={buttonClass.danger}
              onClick={() => setDialog('cancel')}
            >
              {t('eta.actions.cancel')}
            </button>
          ) : null}
        </div>
      </header>

      <p role="status" className="text-sm text-content-muted">
        {t(`eta.hint.${document.state}`)}
      </p>
      {document.lastErrorCode === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-warning bg-warning-subtle p-3 text-sm text-content"
        >
          {lastError(document.lastErrorCode)}
        </p>
      )}
      {failure === null ? null : <Failure error={failure} />}

      {signingRequest === null ? null : (
        <section className={cardClass} aria-labelledby="eta-signing">
          <h2 id="eta-signing" className="text-base font-semibold text-content">
            {t('eta.signing.request')}
          </h2>
          <p className="text-sm text-content-muted">
            {t('eta.signing.requestHint', { date: date(signingRequest.expiresAt) })}
          </p>
          {access.submit || access.sign ? (
            <div>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={withdraw.isPending}
                onClick={() => withdraw.mutate(signingRequest.id)}
              >
                {t('eta.actions.withdraw')}
              </button>
            </div>
          ) : null}
        </section>
      )}

      <section className={cardClass} aria-labelledby="eta-facts">
        <h2 id="eta-facts" className="text-base font-semibold text-content">
          {t('eta.document.facts')}
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-content-muted">{t('eta.document.prepared')}</dt>
          <dd>{date(document.preparedAt)}</dd>
          <dt className="text-content-muted">{t('eta.document.signed')}</dt>
          <dd>{date(document.signedAt)}</dd>
          <dt className="text-content-muted">{t('eta.document.submitted')}</dt>
          <dd>{date(document.submittedAt)}</dd>
          <dt className="text-content-muted">{t('eta.document.final')}</dt>
          <dd>{date(document.finalAt)}</dd>
          {document.nextCheckAt === null ? null : (
            <>
              <dt className="text-content-muted">{t('eta.document.nextCheck')}</dt>
              <dd>{date(document.nextCheckAt)}</dd>
            </>
          )}
          <dt className="text-content-muted">{t('eta.document.etaUuid')}</dt>
          <dd dir="ltr" className="break-all font-mono text-xs">
            {document.etaUuid ?? '—'}
          </dd>
          <dt className="text-content-muted">{t('eta.document.etaStatus')}</dt>
          <dd dir="ltr">{document.etaStatus ?? '—'}</dd>
          <dt className="text-content-muted">{t('eta.document.digest')}</dt>
          <dd dir="ltr" className="break-all font-mono text-xs">
            {document.canonicalSha256}
          </dd>
          <dt className="text-content-muted">{t('eta.document.certificate')}</dt>
          <dd dir="ltr" className="break-all font-mono text-xs">
            {document.signerCertificate ?? '—'}
          </dd>
        </dl>
        <p className="text-sm">
          <a
            href={paths.invoice(document.invoiceId)}
            className="text-accent underline-offset-4 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.invoice(document.invoiceId));
            }}
          >
            {t('eta.document.invoice')}
          </a>
        </p>
      </section>

      {document.errors.length === 0 ? null : (
        <section className={cardClass} aria-labelledby="eta-errors">
          <h2 id="eta-errors" className="text-base font-semibold text-content">
            {t('eta.document.errors')}
          </h2>
          <p className="text-xs text-content-muted">{t('eta.document.errorsHint')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {document.errors.map((error, index) => (
              <li key={`${error.code ?? ''}-${String(index)}`} dir="auto">
                {error.code === null ? null : (
                  <code className="me-2 rounded bg-surface-muted px-1 text-xs" dir="ltr">
                    {error.code}
                  </code>
                )}
                {error.message}
                {error.target === null ? null : (
                  <span className="ms-2 text-xs text-content-muted" dir="ltr">
                    {error.target}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={cardClass} aria-labelledby="eta-attempts">
        <h2 id="eta-attempts" className="text-base font-semibold text-content">
          {t('eta.document.attempts')}
        </h2>
        {attempts.length === 0 ? (
          <p className="text-sm text-content-muted">{t('eta.document.noAttempts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {attempts.map((attempt) => (
              <li key={attempt.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {t(`eta.attempt.kind.${attempt.kind}`)} ·{' '}
                  {t(`eta.attempt.outcome.${attempt.outcome}`)}
                  {attempt.httpStatus === null ? null : (
                    <span className="ms-2 text-xs text-content-muted" dir="ltr">
                      HTTP {attempt.httpStatus}
                    </span>
                  )}
                  {attempt.errorCode === null ? null : (
                    <code className="ms-2 rounded bg-surface-muted px-1 text-xs" dir="ltr">
                      {attempt.errorCode}
                    </code>
                  )}
                </span>
                <span className="text-content-muted">{date(attempt.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog === 'resolve' ? (
        <ResolveDialog documentId={documentId} onClose={() => setDialog(null)} onDone={saved} />
      ) : null}
      {dialog === 'cancel' ? (
        <CancelDialog documentId={documentId} onClose={() => setDialog(null)} onDone={saved} />
      ) : null}
    </div>
  );
}

function ResolveDialog({
  documentId,
  onClose,
  onDone,
}: {
  documentId: string;
  onClose: () => void;
  onDone: (detail: EtaDocumentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [outcome, setOutcome] = useState<'received' | 'not_received'>('received');
  const [uuid, setUuid] = useState('');
  const resolve = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/eta/documents/{documentId}/resolve', {
          params: { path: { documentId } },
          body:
            outcome === 'received'
              ? { outcome: 'received', etaUuid: uuid.trim() }
              : { outcome: 'not_received' },
        })
      ).data!,
    onSuccess: (detail) => {
      onDone(detail);
      onClose();
    },
  });
  return (
    <Dialog
      title={t('eta.resolve.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={resolve.isPending || (outcome === 'received' && uuid.trim().length < 10)}
            onClick={() => resolve.mutate()}
          >
            {t('eta.resolve.confirm')}
          </button>
        </>
      }
    >
      <p>{t('eta.resolve.intro')}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t('eta.resolve.title')}</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="eta-resolve"
            checked={outcome === 'received'}
            onChange={() => setOutcome('received')}
          />
          {t('eta.resolve.received')}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="eta-resolve"
            checked={outcome === 'not_received'}
            onChange={() => setOutcome('not_received')}
          />
          {t('eta.resolve.notReceived')}
        </label>
      </fieldset>
      {outcome === 'received' ? (
        <Field label={t('eta.resolve.uuid')}>
          {(id) => (
            <input
              id={id}
              dir="ltr"
              className={inputClass}
              value={uuid}
              onChange={(event) => setUuid(event.target.value)}
            />
          )}
        </Field>
      ) : (
        <p className="text-content-muted">{t('eta.resolve.notReceivedWarning')}</p>
      )}
      {resolve.error === null ? null : <Failure error={resolve.error} />}
    </Dialog>
  );
}

function CancelDialog({
  documentId,
  onClose,
  onDone,
}: {
  documentId: string;
  onClose: () => void;
  onDone: (detail: EtaDocumentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/eta/documents/{documentId}/cancel', {
          params: { path: { documentId }, header: { 'Idempotency-Key': idempotencyKey() } },
          body: { reason: reason.trim() },
        })
      ).data!,
    onSuccess: (detail) => {
      onDone(detail);
      onClose();
    },
  });
  return (
    <Dialog
      title={t('eta.cancel.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={cancel.isPending || reason.trim().length < 3}
            onClick={() => cancel.mutate()}
          >
            {t('eta.cancel.confirm')}
          </button>
        </>
      }
    >
      <p>{t('eta.cancel.intro')}</p>
      <Field label={t('eta.cancel.reason')}>
        {(id) => (
          <textarea
            id={id}
            dir="auto"
            className={inputClass}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      {cancel.error === null ? null : <Failure error={cancel.error} />}
    </Dialog>
  );
}
