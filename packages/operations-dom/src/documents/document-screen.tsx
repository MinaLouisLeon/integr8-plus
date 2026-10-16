import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type DocumentDetail, keys, useOperations } from '../api.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  copyText,
  Dialog,
  Failure,
  Field,
  fromLocalInput,
  inputClass,
  Loading,
  toLocalInput,
} from '../ui.js';
import {
  documentState,
  DocumentStateBadge,
  failureKey,
  fileSize,
  localized,
  useDocumentAccess,
  useOpenDocument,
} from './document-parts.js';

/**
 * One document (docs/documents ADR-0001 D7, D8): its fields, its PDF to view
 * or download, the QR code's link to copy, and — for those who manage
 * documents — stopping the link now or on a date, and deleting it. A
 * document still being made refreshes itself until it is ready or failed.
 */
export function DocumentScreen({ documentId }: { documentId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useDocumentAccess();
  const open = useOpenDocument();
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const detail = useQuery({
    queryKey: keys.document(documentId),
    queryFn: async () =>
      (
        await client.GET('/v1/documents/{documentId}', {
          params: { path: { documentId } },
        })
      ).data!,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 2000 : false),
  });

  const saved = (next: DocumentDetail) => {
    queries.setQueryData(keys.document(documentId), next);
    void queries.invalidateQueries({ queryKey: ['documents', 'list'] });
  };
  const expire = useMutation({
    mutationFn: async (expired: boolean) =>
      (
        await client.POST('/v1/documents/{documentId}/expire', {
          params: { path: { documentId } },
          body: { expired },
        })
      ).data!,
    onSuccess: saved,
  });
  const remove = useMutation({
    mutationFn: async () => {
      await client.DELETE('/v1/documents/{documentId}', { params: { path: { documentId } } });
    },
    onSuccess: () => {
      queries.removeQueries({ queryKey: keys.document(documentId) });
      void queries.invalidateQueries({ queryKey: ['documents', 'list'] });
      navigate(paths.documents, { replace: true });
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return <Failure error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const document = detail.data;
  const state = documentState(document);

  return (
    <div className="flex flex-col gap-6 text-start">
      <nav>
        <BackLink to={paths.documents} label={t('documents.back')} />
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-content">
            <span dir="auto">{document.title}</span>
            <DocumentStateBadge state={state} />
          </h1>
          <p className="text-sm text-content-muted">
            {t('documents.made', {
              date: formatDateTime(document.createdAt, { locale }),
              name: document.createdBy.name,
            })}
            {document.pageCount === null
              ? null
              : ` · ${t('documents.pages', { count: document.pageCount })}`}
            {document.byteSize === null
              ? null
              : ` · ${t('documents.size', { size: fileSize(document.byteSize, locale) })}`}
          </p>
        </div>
        {document.status === 'ready' ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => void open(document.id, 'inline')}
            >
              {t('documents.view')}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => void open(document.id, 'attachment')}
            >
              {t('documents.download')}
            </button>
          </div>
        ) : null}
      </header>

      {document.status === 'pending' ? (
        <p role="status" className="text-sm text-content-muted">
          {t('documents.pendingHint')}
        </p>
      ) : null}
      {document.status === 'failed' ? (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
        >
          {t(failureKey(document.failureCode))}
        </p>
      ) : null}

      <section className={cardClass} aria-labelledby="document-fields">
        <h2 id="document-fields" className="mb-3 text-lg font-semibold text-content">
          {t('documents.fields')}
        </h2>
        {document.fields.length === 0 ? (
          <p className="text-sm text-content-muted">{t('documents.noFields')}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            {document.fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="text-content-muted">
                  {localized(field.label, locale)}
                  {field.lookupRole === null ? null : (
                    <span className="ms-2 rounded border border-border-subtle px-1 text-xs">
                      {field.lookupRole === 'key'
                        ? t('documents.lookupKey')
                        : t('documents.lookupConfirm')}
                    </span>
                  )}
                </dt>
                <dd className="text-content" dir="auto">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-4 text-sm">
          <a
            href={paths.submission(document.submissionId)}
            className="text-accent underline-offset-4 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.submission(document.submissionId));
            }}
          >
            {t('documents.submission')}
          </a>
        </p>
      </section>

      {document.link === null || document.status !== 'ready' ? null : (
        <section className={cardClass} aria-labelledby="document-link">
          <h2 id="document-link" className="mb-1 text-lg font-semibold text-content">
            {t('documents.link')}
          </h2>
          <p className="mb-3 text-sm text-content-muted">
            {document.linkOpens ? t('documents.linkHint') : t('documents.expiredHint')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code dir="ltr" className="break-all rounded bg-surface-muted px-2 py-1 text-sm">
              {document.link}
            </code>
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => {
                copyText(document.link ?? '');
                setCopied(true);
              }}
            >
              {copied ? t('documents.copied') : t('documents.copyLink')}
            </button>
          </div>
          {document.expiresAt === null ? null : (
            <p className="mt-2 text-sm text-content-muted">
              {/* Not stopped by a person, yet closed: its date has passed. */}
              {document.expiredAt === null && !document.linkOpens
                ? t('documents.expiryPassed', {
                    date: formatDateTime(document.expiresAt, { locale }),
                  })
                : t('documents.expiryFuture', {
                    date: formatDateTime(document.expiresAt, { locale }),
                  })}
            </p>
          )}
          {access.manage ? (
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={expire.isPending}
                  onClick={() => expire.mutate(document.expiredAt === null)}
                >
                  {document.expiredAt === null ? t('documents.expire') : t('documents.unexpire')}
                </button>
              </div>
              {expire.isError ? <Failure error={expire.error} /> : null}
              <ExpiryForm document={document} onSaved={saved} />
            </div>
          ) : null}
        </section>
      )}

      {access.manage ? (
        <div>
          <button type="button" className={buttonClass.danger} onClick={() => setDeleting(true)}>
            {t('documents.delete')}
          </button>
        </div>
      ) : null}

      {deleting ? (
        <Dialog
          title={t('documents.deleteTitle')}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setDeleting(false)}
              >
                {t('documents.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.danger}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t('documents.delete')}
              </button>
            </>
          }
        >
          <p className="text-sm text-content">{t('documents.deleteBody')}</p>
          {remove.isError ? <Failure error={remove.error} /> : null}
        </Dialog>
      ) : null}
    </div>
  );
}

function ExpiryForm({
  document,
  onSaved,
}: {
  document: DocumentDetail;
  onSaved: (next: DocumentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [value, setValue] = useState(toLocalInput(document.expiresAt));
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/documents/{documentId}', {
          params: { path: { documentId: document.id } },
          body: { expiresAt: fromLocalInput(value) },
        })
      ).data!,
    onSuccess: onSaved,
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Field label={t('documents.expiresAt')}>
        {(id) => (
          <input
            id={id}
            type="datetime-local"
            className={inputClass}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </Field>
      <button type="submit" className={buttonClass.secondary} disabled={save.isPending}>
        {t('documents.saveExpiry')}
      </button>
      <p className="basis-full text-xs text-content-muted">{t('documents.expiresAtHint')}</p>
      {save.isError ? <Failure error={save.error} /> : null}
    </form>
  );
}
