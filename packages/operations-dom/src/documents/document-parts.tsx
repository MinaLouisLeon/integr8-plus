import { hasFeature } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import type { DocumentDetail, DocumentRow, DocumentState } from '../api.js';
import { keys, useOperations } from '../api.js';

/**
 * Pieces the document screens share (docs/documents ADR-0001): who may do
 * what, the state badge, a document's label in the reader's language, and
 * opening its PDF.
 */

/** What this seat may do with the company's documents. */
export function useDocumentAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'documents');
  return {
    loaded: me.data !== undefined,
    enabled,
    read: enabled && permissions.includes('document.read'),
    create: enabled && permissions.includes('document.create'),
    manage: enabled && permissions.includes('document.manage'),
    /** Upload a PDF, and switch any document's sharing (0067). */
    upload: enabled && permissions.includes('document.upload'),
  };
}

/** Marks an uploaded document or a business PDF's kind, and one that is not shared, beside its state. */
export function DocumentMarks({
  document,
}: {
  document: Pick<DocumentRow, 'source' | 'shareable' | 'status'>;
}) {
  const { t } = useTranslation();
  return (
    <>
      {document.source === 'uploaded' ? (
        <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-content-muted">
          {t('documents.upload.badge')}
        </span>
      ) : document.source !== 'generated' ? (
        <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-content-muted">
          {t(`businessPdfs.kind.${document.source}`)}
        </span>
      ) : null}
      {document.status === 'ready' && !document.shareable ? (
        <span className="rounded-full border border-border-subtle bg-surface-muted px-2 py-0.5 text-xs font-medium text-content-muted">
          {t('documents.sharing.badge')}
        </span>
      ) : null}
    </>
  );
}

/** Where a document stands, as one word: its link open or stopped, being made, or failed. */
export function documentState(document: DocumentRow | DocumentDetail): DocumentState {
  if (document.status === 'pending') {
    return 'pending';
  }
  if (document.status === 'failed') {
    return 'failed';
  }
  return document.linkOpens ? 'active' : 'expired';
}

const STATE_CLASS: Record<DocumentState, string> = {
  active: 'border-success bg-success-subtle text-content',
  expired: 'border-border-subtle bg-surface-muted text-content-muted',
  pending: 'border-warning bg-warning-subtle text-content',
  failed: 'border-danger bg-danger-subtle text-content',
};

export function DocumentStateBadge({ state }: { state: DocumentState }) {
  const { t } = useTranslation();
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_CLASS[state]}`}>
      {t(`documents.state.${state}`)}
    </span>
  );
}

/** A label written in both languages, in the reader's when it has one. */
export function localized(label: Readonly<Record<string, string>>, locale: string): string {
  const language = locale.startsWith('ar') ? 'ar' : 'en';
  return label[language] ?? label.en ?? Object.values(label)[0] ?? '';
}

const FAILURES = [
  'renderer_unavailable',
  'render_timeout',
  'render_failed',
  'template_invalid',
  'source_missing',
  'storage_unavailable',
  'storage_quota_exceeded',
] as const;

/** Why a document failed, as the key of the words that say so. */
export function failureKey(
  code: string | null,
): `documents.failure.${(typeof FAILURES)[number] | 'unknown'}` {
  const known = FAILURES.find((candidate) => candidate === code);
  return `documents.failure.${known ?? 'unknown'}`;
}

/** A file size the way people say it: 84 kB, 1.2 MB. */
export function fileSize(bytes: number, locale: string): string {
  const megabytes = bytes >= 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: megabytes ? 'megabyte' : 'kilobyte',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(megabytes ? bytes / 1_000_000 : Math.max(1, Math.round(bytes / 1000)));
}

/** Opens a document's PDF in a new window, to read or to save. */
export function useOpenDocument() {
  const { client } = useOperations();
  return async (documentId: string, disposition: 'inline' | 'attachment') => {
    const { data } = await client.GET('/v1/documents/{documentId}/file', {
      params: { path: { documentId }, query: { disposition } },
    });
    if (data !== undefined) {
      window.open(data.url, '_blank', 'noopener');
    }
  };
}
