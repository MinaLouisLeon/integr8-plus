import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { type Customer, type DocumentDetail, keys, useOperations } from '../api.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { buttonClass, Dialog, Failure, Field, inputClass } from '../ui.js';

/** The largest PDF the register takes (0067); the API refuses anything larger too. */
export const DOCUMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** What the browser says the file is; the API checks the bytes themselves. */
const isPdf = (file: File) =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

/**
 * Uploading a PDF the company already has into the register (docs/documents,
 * 0067): the file, a title, its reference number (what the website lookup
 * finds it by) and, optionally, the customer it is for. It is not shared
 * unless the box is ticked.
 */
export function UploadDocumentDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: (document: DocumentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const adapter = useMemo(() => apiMediaAdapter(client), [client]);
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [customer, setCustomer] = useState<Pick<Customer, 'id' | 'name'> | null>(null);
  const [share, setShare] = useState(false);
  const idempotencyKey = useIdempotencyKey({
    name: file?.name ?? null,
    size: file?.size ?? null,
    title,
    reference,
    customer: customer?.id ?? null,
    share,
  });

  const problem =
    file === null
      ? null
      : !isPdf(file)
        ? t('documents.upload.notPdf')
        : file.size > DOCUMENT_UPLOAD_MAX_BYTES
          ? t('documents.upload.tooLarge')
          : null;
  const ready = file !== null && problem === null && title.trim() !== '' && reference.trim() !== '';

  const upload = useMutation({
    mutationFn: async () => {
      const stored = await adapter.upload(file!, { contentType: 'application/pdf' });
      return (
        await client.POST('/v1/documents', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            fileId: stored.mediaId,
            title: title.trim(),
            reference: reference.trim(),
            ...(customer === null ? {} : { customerId: customer.id }),
            shareable: share,
          },
        })
      ).data!;
    },
    onSuccess: (document) => {
      queries.setQueryData(keys.document(document.id), document);
      void queries.invalidateQueries({ queryKey: ['documents', 'list'] });
      onUploaded(document);
    },
  });

  return (
    <Dialog
      title={t('documents.upload.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('documents.upload.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={!ready || upload.isPending}
          >
            {upload.isPending ? t('documents.upload.uploading') : t('documents.upload.submit')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            upload.mutate();
          }
        }}
      >
        <p className="text-sm text-content-muted">{t('documents.upload.intro')}</p>
        <Field label={t('documents.upload.file')} hint={t('documents.upload.fileHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="file"
              accept="application/pdf,.pdf"
              className={inputClass}
              aria-describedby={describedBy}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                if (chosen !== null && isPdf(chosen) && title.trim() === '') {
                  setTitle(chosen.name.replace(/\.pdf$/iu, '').slice(0, 200));
                }
              }}
            />
          )}
        </Field>
        {problem === null ? null : (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
        <Field label={t('documents.upload.documentTitle')}>
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={title}
              maxLength={200}
              required
              dir="auto"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('documents.upload.reference')} hint={t('documents.upload.referenceHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              className={inputClass}
              value={reference}
              maxLength={100}
              required
              dir="auto"
              onChange={(event) => setReference(event.target.value)}
            />
          )}
        </Field>
        <CustomerPicker
          label={t('documents.upload.customer')}
          value={customer}
          onChange={setCustomer}
        />
        <p className="text-xs text-content-muted">{t('documents.upload.customerHint')}</p>
        <label className="flex items-start gap-2 text-sm text-content">
          <input
            type="checkbox"
            className="mt-1"
            checked={share}
            onChange={(event) => setShare(event.target.checked)}
          />
          {t('documents.upload.shareNow')}
        </label>
        {upload.isError ? <Failure error={upload.error} /> : null}
      </form>
    </Dialog>
  );
}
