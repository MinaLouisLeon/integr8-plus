import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { keys, type PurchaseOrderStatus, type SupplierStatus, useOperations } from '../api.js';

/**
 * Pieces the purchasing screens share (CRM/ERP plan, phase E2): status
 * badges, the company's active suppliers, and tax rates between the basis
 * points the API keeps and the percentage people type.
 */

const STATUS_STYLE: Record<PurchaseOrderStatus, string> = {
  draft: 'border-border-subtle bg-surface-muted text-content',
  approved: 'border-accent bg-surface text-content',
  partially_received: 'border-accent bg-surface text-content',
  received: 'border-border-subtle bg-surface-muted text-content-muted',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

export function OrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {t(`purchasing.status.${status}`)}
    </span>
  );
}

export function SupplierStatusBadge({ status }: { status: SupplierStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${
        status === 'active'
          ? 'border-accent text-content'
          : 'border-border-subtle text-content-muted'
      }`}
    >
      {t(`purchasing.supplierStatus.${status}`)}
    </span>
  );
}

/** The suppliers an order may be placed with. */
export function useActiveSuppliers() {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.suppliers({ status: 'active', limit: 200 }),
    queryFn: async () =>
      (await client.GET('/v1/purchasing/suppliers', { params: { query: { limit: 200 } } })).data!
        .items,
  });
}

/** Basis points as the percentage people read: 1450 → `14.5`. Never a float. */
export function percentOfBasisPoints(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = bp % 100;
  if (rest === 0) {
    return String(whole);
  }
  return `${whole}.${String(rest).padStart(2, '0')}`.replace(/0$/u, '');
}

/** A typed percentage as basis points: `14.5` → 1450; undefined when it is not one. */
export function basisPointsOfPercent(text: string): number | undefined {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/u.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp > 10_000 ? undefined : bp;
}

export const QUANTITY_PATTERN = String.raw`\d{1,16}(\.\d{1,4})?`;
export const isQuantity = (text: string) => /^\d{1,16}(\.\d{1,4})?$/u.test(text.trim());
export const isPositiveQuantity = (text: string) =>
  isQuantity(text) && /[1-9]/u.test(text.replace(/^0+/u, ''));

/**
 * One idempotency key per distinct request: a retry of the same request
 * replays the first answer, a changed request posts anew.
 */
export function useIdempotencyKey(request: unknown): string {
  const text = JSON.stringify(request);
  return useMemo(() => (text === '' ? '' : crypto.randomUUID()), [text]);
}
