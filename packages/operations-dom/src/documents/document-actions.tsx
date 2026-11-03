import { useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type DocumentDetail, keys, useOperations } from '../api.js';
import { QrCode } from '../assets/asset-tag.js';
import { buttonClass, copyText, Dialog, Failure, inputClass } from '../ui.js';
import { useDocumentAccess } from './document-parts.js';

/**
 * What can be done to a document from the list as well as from its page:
 * share it (switch sharing on and open the share menu), stop sharing it, and
 * delete it after a confirmation. Each button is shown only to those the
 * server would let do it: sharing needs `document.upload`, deleting
 * `document.manage`.
 */

/** At most this many fields can be typed on one uploaded document (0075); the API agrees. */
export const TYPED_FIELDS_MAX = 10;

export interface TypedField {
  label: string;
  value: string;
}

/** The fields a person typed on an uploaded document, as the editor holds them. */
export function typedFieldsOf(document: Pick<DocumentDetail, 'fields'>): TypedField[] {
  return document.fields
    .filter((field) => field.lookupRole === 'search')
    .map((field) => ({
      label: field.label.en ?? Object.values(field.label)[0] ?? '',
      value: field.value,
    }));
}

/** Rows that will be sent: both halves filled in, trimmed. */
export function completeFields(fields: readonly TypedField[]): TypedField[] {
  return fields
    .map((field) => ({ label: field.label.trim(), value: field.value.trim() }))
    .filter((field) => field.label !== '' && field.value !== '');
}

/** Why the fields cannot be sent, or null: two with one name, or a half-filled row. */
export function typedFieldsProblem(
  fields: readonly TypedField[],
): 'duplicate' | 'incomplete' | null {
  const trimmed = fields.map((field) => ({ label: field.label.trim(), value: field.value.trim() }));
  if (trimmed.some((field) => (field.label === '') !== (field.value === ''))) {
    return 'incomplete';
  }
  const names = trimmed
    .filter((field) => field.label !== '')
    .map((field) => field.label.toLocaleLowerCase('en'));
  return new Set(names).size === names.length ? null : 'duplicate';
}

/**
 * Name and value pairs typed for a document (0075), such as "Serial number:
 * 12345": shown with it, and found by the search here and on the company's
 * website.
 */
export function TypedFieldsEditor({
  value,
  onChange,
}: {
  value: readonly TypedField[];
  onChange: (next: TypedField[]) => void;
}) {
  const { t } = useTranslation();
  const problem = typedFieldsProblem(value);
  const update = (index: number, change: Partial<TypedField>) =>
    onChange(value.map((field, at) => (at === index ? { ...field, ...change } : field)));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-content">
        {t('documents.typedFields.title')}
      </legend>
      <p className="text-xs text-content-muted">{t('documents.typedFields.hint')}</p>
      {value.map((field, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={t('documents.typedFields.name', { number: index + 1 })}
            placeholder={t('documents.typedFields.namePlaceholder')}
            className={`${inputClass} min-w-32 flex-1`}
            value={field.label}
            maxLength={60}
            dir="auto"
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <input
            aria-label={t('documents.typedFields.value', { number: index + 1 })}
            placeholder={t('documents.typedFields.valuePlaceholder')}
            className={`${inputClass} min-w-32 flex-[2]`}
            value={field.value}
            maxLength={500}
            dir="auto"
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className={buttonClass.ghost}
            aria-label={t('documents.typedFields.remove', { number: index + 1 })}
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            {t('documents.typedFields.removeShort')}
          </button>
        </div>
      ))}
      {value.length < TYPED_FIELDS_MAX ? (
        <div>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => onChange([...value, { label: '', value: '' }])}
          >
            {t('documents.typedFields.add')}
          </button>
        </div>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {t(`documents.typedFields.${problem}`)}
        </p>
      )}
    </fieldset>
  );
}

/** Changing the typed fields of an uploaded document, from its page. */
export function TypedFieldsForm({
  document,
  onSaved,
}: {
  document: DocumentDetail;
  onSaved: (next: DocumentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [fields, setFields] = useState<TypedField[]>(() => typedFieldsOf(document));
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/documents/{documentId}/fields', {
          params: { path: { documentId: document.id } },
          body: { fields: completeFields(fields) },
        })
      ).data!,
    onSuccess: (next) => {
      setFields(typedFieldsOf(next));
      onSaved(next);
    },
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (typedFieldsProblem(fields) === null) {
          save.mutate();
        }
      }}
    >
      <TypedFieldsEditor value={fields} onChange={setFields} />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className={buttonClass.secondary}
          disabled={save.isPending || typedFieldsProblem(fields) !== null}
        >
          {t('documents.typedFields.save')}
        </button>
        {save.isSuccess ? (
          <span role="status" className="text-sm text-content-muted">
            {t('documents.typedFields.saved')}
          </span>
        ) : null}
      </div>
      {save.isError ? <Failure error={save.error} /> : null}
    </form>
  );
}

/** Opens an address outside the app: the mail app, WhatsApp. */
function openOutside(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/**
 * Where to send a shared document's link: copy it, email it, send it on
 * WhatsApp, or show its QR code to scan. The link is the company's own
 * website's page when Integr8 set one up (0075), Integr8's otherwise.
 */
export function ShareDialog({
  document,
  onClose,
}: {
  document: Pick<DocumentDetail, 'title' | 'link'>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const link = document.link ?? '';
  const message = t('documents.shareMenu.message', { title: document.title, link });

  return (
    <Dialog
      title={t('documents.shareMenu.title')}
      onClose={onClose}
      footer={
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          {t('documents.shareMenu.done')}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-content-muted" dir="auto">
          {document.title}
        </p>
        <code dir="ltr" className="break-all rounded bg-surface-muted px-2 py-1 text-sm">
          {link}
        </code>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => {
              copyText(link);
              setCopied(true);
            }}
          >
            {copied ? t('documents.copied') : t('documents.copyLink')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              openOutside(
                `mailto:?subject=${encodeURIComponent(document.title)}&body=${encodeURIComponent(message)}`,
              )
            }
          >
            {t('documents.shareMenu.email')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => openOutside(`https://wa.me/?text=${encodeURIComponent(message)}`)}
          >
            {t('documents.shareMenu.whatsapp')}
          </button>
        </div>
        <div className="flex flex-col items-start gap-1">
          <span className="text-sm font-medium text-content">{t('documents.shareMenu.qr')}</span>
          <QrCode
            text={link}
            label={t('documents.sharing.qr')}
            className="h-40 w-40 rounded border border-border-subtle"
          />
        </div>
      </div>
    </Dialog>
  );
}

/** Share, stop sharing and delete, for one document; the same three wherever it is shown. */
export function useDocumentActions(documentId: string, onDeleted?: () => void) {
  const { client } = useOperations();
  const queries = useQueryClient();
  const saved = (next: DocumentDetail) => {
    queries.setQueryData(keys.document(documentId), next);
    void queries.invalidateQueries({ queryKey: ['documents', 'list'] });
  };
  const share = useMutation({
    mutationFn: async (shareable: boolean) =>
      (
        await client.POST('/v1/documents/{documentId}/share', {
          params: { path: { documentId } },
          body: { shareable },
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
      onDeleted?.();
    },
  });
  return { share, remove, saved };
}

/** Asks before a document, its link and its file go. */
export function DeleteDocumentDialog({
  pending,
  error,
  onConfirm,
  onClose,
}: {
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t('documents.deleteTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('documents.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={pending}
            onClick={onConfirm}
          >
            {t('documents.delete')}
          </button>
        </>
      }
    >
      <p className="text-sm text-content">{t('documents.deleteBody')}</p>
      {error === null || error === undefined ? null : <Failure error={error} />}
    </Dialog>
  );
}

/**
 * The buttons on a document's row in the list: Share (or, once shared, the
 * share menu again) and Stop sharing, for those who may switch sharing, and
 * Delete, for those who manage documents. A document not ready yet has no
 * link to share.
 */
export function DocumentRowActions({ document }: { document: DocumentDetail }) {
  const { t } = useTranslation();
  const access = useDocumentAccess();
  const { share, remove } = useDocumentActions(document.id);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const shareable = document.status === 'ready' && document.link !== null;

  if (!access.upload && !access.manage) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {access.upload && shareable ? (
        <button
          type="button"
          className={buttonClass.ghost}
          disabled={share.isPending}
          onClick={() => {
            if (document.shareable) {
              setSharing(true);
            } else {
              share.mutate(true, { onSuccess: () => setSharing(true) });
            }
          }}
        >
          {t('documents.actions.share')}
        </button>
      ) : null}
      {access.upload && document.shareable ? (
        <button
          type="button"
          className={buttonClass.ghost}
          disabled={share.isPending}
          onClick={() => share.mutate(false)}
        >
          {t('documents.actions.unshare')}
        </button>
      ) : null}
      {access.manage ? (
        <button
          type="button"
          className={`${buttonClass.ghost} text-danger`}
          onClick={() => setDeleting(true)}
        >
          {t('documents.actions.delete')}
        </button>
      ) : null}
      {share.isError ? <Failure error={share.error} /> : null}
      {sharing ? (
        <ShareDialog document={share.data ?? document} onClose={() => setSharing(false)} />
      ) : null}
      {deleting ? (
        <DeleteDocumentDialog
          pending={remove.isPending}
          error={remove.error}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => setDeleting(false) })}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </div>
  );
}
