import { ApiRequestError, type Integr8Client } from '@integr8/api-client';
import { hasFeature } from '@integr8/core';
import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { type ExpenseClaimStatus, type ExpenseReceipt, keys, useOperations } from '../api.js';
import { Failure } from '../ui.js';

/**
 * Pieces the expense-claim screens share (seventh round; ADR-0010): who may
 * do what, the refusals the server gives in words of this language, a claim's
 * status, the company's categories and currency, and sending a receipt.
 *
 * Money is a decimal string from end to end: what is typed is checked as
 * text, sent as text and formatted as text, never added up as a JavaScript
 * number.
 */

/** What this seat may do with the company's expense claims. */
export function useExpenseAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions: readonly string[] = me.data?.permissions ?? [];
  const features = me.data?.features;
  const enabled = me.data !== undefined && hasFeature(features, 'hr');
  return {
    loaded: me.data !== undefined,
    enabled,
    userId: me.data?.userId ?? null,
    submit: enabled && permissions.includes('expense.submit'),
    approve: enabled && permissions.includes('expense.approve'),
    /** Whether an approved claim may be paid back through the next pay run. */
    payroll: me.data !== undefined && hasFeature(features, 'payroll'),
    /** Whether categories can be pointed at a ledger account this seat can see. */
    ledger:
      me.data !== undefined &&
      hasFeature(features, 'ledger') &&
      permissions.includes('ledger.read'),
  };
}

/** The categories in use, or every one with the archived, for those who keep them. */
export function useExpenseCategories(includeArchived = false, enabled = true) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.expenseCategories(includeArchived),
    queryFn: async () =>
      (
        await client.GET('/v1/expenses/categories', {
          params: { query: includeArchived ? { archived: 'true' } : {} },
        })
      ).data!.items,
    enabled,
  });
}

/** The company's currency, which every claim is in. */
export function useCompanyCurrency(): string | null {
  const { client } = useOperations();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
  });
  return settings.data?.currency ?? null;
}

/** Today in the reader's own calendar, as the API writes a date. */
export function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** The code a request was refused with, when it was refused with one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiRequestError ? error.code : undefined;
}

/**
 * A request the expenses API refused, in words (ADR-0012), with this area's
 * own wording where a code means more here: who decides a claim, a category's
 * name, the expense account. A field the server names with a known reason,
 * such as a date ahead, is a line under the message.
 */
export function ExpenseFailure({
  error,
  onRetry,
  actions,
}: {
  error: unknown;
  onRetry?: () => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Failure
      error={error}
      onRetry={onRetry}
      actions={actions}
      overrides={{
        self_approval: t('expenses.errors.self_approval'),
        name_taken: t('expenses.errors.name_taken'),
        account_not_usable: t('expenses.errors.account_not_usable'),
      }}
    />
  );
}

const STATUS_STYLE: Record<ExpenseClaimStatus, string> = {
  submitted: 'border-warning bg-warning-subtle text-content',
  approved: 'border-accent bg-surface text-content',
  paid: 'border-success bg-success-subtle text-content',
  rejected: 'border-danger bg-danger-subtle text-content',
  withdrawn: 'border-border-subtle bg-surface-muted text-content-muted',
};

/** Where a claim is, in words, never colour alone. */
export function ClaimStatusBadge({ status }: { status: ExpenseClaimStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {t(`expenses.status.${status}`)}
    </span>
  );
}

/** A short note, such as why a form is not offered. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-muted p-4 text-start text-sm text-content">
      {children}
    </div>
  );
}

/** The file types a receipt may be: a photo, or a PDF the shop sent. */
export const RECEIPT_ACCEPT = 'image/*,application/pdf';

/** A receipt's title: the file's name, cut to what the API keeps. */
export function receiptTitle(file: File): string {
  const name = file.name.trim();
  return (name === '' ? 'Receipt' : name).slice(0, 200);
}

/**
 * Sends receipts and opens them: upload a file, attach it to the claim, and
 * fetch a short-lived link to read one back.
 */
export function useReceipts() {
  const { client } = useOperations();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  return {
    attach: (claimId: string, file: File) => attachReceipt(client, media, claimId, file),
    open: async (receipt: ExpenseReceipt) => {
      const url = await media.url({
        mediaId: receipt.fileId,
        contentType: receipt.contentType,
        byteSize: receipt.byteSize,
      });
      window.open(url, '_blank', 'noopener');
    },
  };
}

async function attachReceipt(
  client: Integr8Client,
  media: ReturnType<typeof apiMediaAdapter>,
  claimId: string,
  file: File,
): Promise<void> {
  const contentType = file.type === '' ? 'application/octet-stream' : file.type;
  const reference = await media.upload(file, { contentType });
  await client.POST('/v1/attachments', {
    params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
    body: {
      owner: { expenseClaimId: claimId },
      fileId: reference.mediaId,
      title: receiptTitle(file),
      kind: contentType.startsWith('image/') ? 'photo' : 'other',
    },
  });
}
