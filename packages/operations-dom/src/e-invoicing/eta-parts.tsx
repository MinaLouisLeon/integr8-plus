import { hasFeature } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import type { EtaDocumentState, EtaReadinessIssue } from '../api.js';
import { keys, useOperations } from '../api.js';

/**
 * Pieces the e-invoicing screens share (docs/e-invoicing; ADR-0014): who may
 * do what, the state badge, the readiness and error codes in words, and
 * saving the ETA's PDF.
 */

export function useEtaAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'e_invoicing');
  return {
    loaded: me.data !== undefined,
    enabled,
    read: enabled && permissions.includes('eta.read'),
    prepare: enabled && permissions.includes('eta.prepare'),
    configure: enabled && permissions.includes('eta.configure'),
    sign: enabled && permissions.includes('eta.sign'),
    submit: enabled && permissions.includes('eta.submit'),
    role: me.data?.role,
  };
}

const STATE_TONE: Record<EtaDocumentState, string> = {
  ready: 'border-border-subtle bg-surface-muted text-content',
  pending_signature: 'border-warning bg-warning-subtle text-content',
  signed: 'border-accent bg-surface text-content',
  submitting: 'border-accent bg-surface text-content',
  submitted: 'border-accent bg-surface text-content',
  valid: 'border-success bg-success-subtle text-content',
  invalid: 'border-danger bg-danger-subtle text-content',
  rejected: 'border-danger bg-danger-subtle text-content',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted',
  failed: 'border-danger bg-danger-subtle text-content',
  unknown: 'border-warning bg-warning-subtle text-content',
  superseded: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

/** A document's state, in words, never colour alone. */
export function EtaStateBadge({ state }: { state: EtaDocumentState }) {
  const { t } = useTranslation();
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}>
      {t(`eta.state.${state}`)}
    </span>
  );
}

const READINESS_CODES = [
  'invoice_not_issued',
  'issuer_missing',
  'issuer_field_missing',
  'receiver_missing',
  'receiver_id_missing',
  'receiver_address_missing',
  'receiver_field_missing',
  'line_item_code_missing',
  'line_unit_unmapped',
  'line_tax_unmapped',
  'exchange_rate_missing',
  'exchange_rate_invalid',
  'text_unsupported',
  'amount_invalid',
  'total_differs',
] as const;
type ReadinessCode = (typeof READINESS_CODES)[number];
const isReadinessCode = (code: string): code is ReadinessCode =>
  (READINESS_CODES as readonly string[]).includes(code);

/** One readiness finding, in words, with where it is. */
export function useReadinessText(): (issue: EtaReadinessIssue) => string {
  const { t } = useTranslation();
  // Each message takes a different subset of these values; i18next ignores the rest.
  const say = t as unknown as (key: string, values: Record<string, string>) => string;
  return (issue) => {
    const values = { ...issue.params, path: issue.path, code: issue.code };
    return isReadinessCode(issue.code)
      ? say(`eta.readiness.${issue.code}`, values)
      : say('eta.readiness.other', values);
  };
}

const LAST_ERRORS = [
  'eta_submission_interrupted',
  'eta_answer_unclear',
  'eta_document_rejected',
  'eta_signature_refused',
  'eta_timeout',
  'eta_network',
  'eta_server',
  'eta_unauthorized',
  'eta_forbidden',
  'eta_bad_request',
  'eta_rate_limited',
  'eta_not_found',
  'eta_unexpected',
  'eta_environment_changed',
  'eta_credentials_missing',
  'eta_credentials_unreadable',
  'eta_key_missing',
  'eta_disabled',
  'eta_production_disabled',
  'eta_document_unsigned',
  'feature_disabled',
] as const;
type LastError = (typeof LAST_ERRORS)[number];
const isLastError = (code: string): code is LastError =>
  (LAST_ERRORS as readonly string[]).includes(code);

/** Why a document stopped where it is, from its last error code. */
export function useLastErrorText(): (code: string) => string {
  const { t } = useTranslation();
  return (code) =>
    isLastError(code) ? t(`eta.lastError.${code}`) : t('eta.lastError.other', { code });
}

/** Saves the ETA's PDF of a document. */
export function useEtaPdf(): (documentId: string) => Promise<void> {
  const { client, download } = useOperations();
  return async (documentId) => {
    const { data } = await client.GET('/v1/eta/documents/{documentId}/pdf', {
      params: { path: { documentId } },
    });
    if (data === undefined) {
      return;
    }
    const bytes = Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0));
    download(new Blob([bytes], { type: data.contentType }), data.fileName);
  };
}

/** A fresh key for a request the server must never act on twice. */
export function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
