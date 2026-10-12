import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { keys, type PurchaseOrderStatus, type SupplierStatus, useOperations } from '../api.js';
import { inputClass } from '../ui.js';

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

/**
 * What is left of one decimal quantity after another, to four places and
 * never below zero: `5` less `1.5` is `3.5`. Exact, never a float.
 */
export function remainingQuantity(total: string, taken: string): string {
  const scale = (text: string) => {
    const [whole = '0', fraction = ''] = text.split('.');
    return BigInt(whole + fraction.padEnd(4, '0').slice(0, 4));
  };
  const left = scale(total) - scale(taken);
  if (left <= 0n) {
    return '0';
  }
  const digits = left.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`.replace(/\.?0+$/u, '');
}

/** Whether this seat sees supplier prices: those who manage purchasing or move stock. */
export function seesPrices(permissions: readonly string[]): boolean {
  return permissions.includes('purchasing.manage') || permissions.includes('inventory.move');
}

/** Suppliers to choose from: the active ones, or every one when `includeInactive`. */
export function useSuppliers(includeInactive = false, enabled = true) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.suppliers({ includeInactive, limit: 200 }),
    queryFn: async () =>
      (
        await client.GET('/v1/purchasing/suppliers', {
          params: {
            query: includeInactive
              ? { status: ['active', 'inactive'], limit: 200 }
              : { limit: 200 },
          },
        })
      ).data!.items,
    enabled,
  });
}

/**
 * Chooses a supplier by name, never by id. Active suppliers are offered; an
 * inactive one only when it is the current choice (or `includeInactive`),
 * said so beside its name.
 */
export function SupplierPicker({
  id,
  value,
  onChange,
  noneLabel,
  describedBy,
  includeInactive = false,
  required = false,
  label,
}: {
  id: string;
  value: string;
  onChange: (supplierId: string) => void;
  /** The words for choosing nobody. */
  noneLabel: string;
  describedBy?: string | undefined;
  includeInactive?: boolean;
  required?: boolean;
  /** An accessible name, when the picker has no visible label of its own. */
  label?: string;
}) {
  const { t } = useTranslation();
  const suppliers = useSuppliers(true);
  const offered = (suppliers.data ?? []).filter(
    (supplier) => supplier.status === 'active' || includeInactive || supplier.id === value,
  );
  return (
    <select
      id={id}
      required={required}
      aria-label={label}
      aria-describedby={describedBy}
      className={inputClass}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{noneLabel}</option>
      {offered.map((supplier) => (
        <option key={supplier.id} value={supplier.id}>
          {supplier.status === 'active'
            ? supplier.name
            : `${supplier.name} (${t('purchasing.supplierStatus.inactive')})`}
        </option>
      ))}
    </select>
  );
}
