import { ApiRequestError } from '@integr8/api-client';
import { hasFeature } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  type AssemblyDirection,
  type AssemblyOrderStatus,
  type BomRow,
  keys,
  useOperations,
} from '../api.js';
import { buttonClass, Failure, Field, inputClass, Loading } from '../ui.js';

/**
 * Pieces the manufacturing screens share (seventh round; ADR-0011): what the
 * seat may do, badges in words, the refusals the API names said in this
 * language, a picker for items that have a bill, and quantities checked as
 * text — never as floating-point numbers.
 */

/** What the signed-in seat may do with manufacturing, read once from `/v1/me`. */
export function useManufacturingSeat() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  return {
    me,
    enabled: me.data !== undefined && hasFeature(me.data.features, 'manufacturing'),
    read: permissions.includes('manufacturing.read'),
    manage: permissions.includes('manufacturing.manage'),
    /** The API hides costs from seats that may not move stock. */
    seesCosts: permissions.includes('inventory.move'),
    purchasing:
      me.data !== undefined &&
      hasFeature(me.data.features, 'purchasing') &&
      permissions.includes('purchasing.read'),
  };
}

/** The company currency, for costs. */
export function useCurrency(): string {
  const { client } = useOperations();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
  });
  return settings.data?.currency ?? 'EGP';
}

export const QUANTITY_PATTERN = String.raw`\d{1,16}(\.\d{1,4})?`;
const QUANTITY = /^\d{1,16}(\.\d{1,4})?$/u;
/** A quantity greater than zero, with up to four places, as the API takes it. */
export const isPositiveQuantity = (text: string) =>
  QUANTITY.test(text.trim()) && /[1-9]/u.test(text);
/** A cost of zero or more, with up to four places. */
export const isAmount = (text: string) => QUANTITY.test(text.trim());

const STATUS_STYLE: Record<AssemblyOrderStatus, string> = {
  draft: 'border-border-subtle bg-surface-muted text-content',
  completed: 'border-success bg-success-subtle text-content',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

export function AssemblyStatusBadge({ status }: { status: AssemblyOrderStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {t(`manufacturing.status.${status}`)}
    </span>
  );
}

export function DirectionBadge({ direction }: { direction: AssemblyDirection }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
      {t(`manufacturing.direction.${direction}`)}
    </span>
  );
}

/** A link that goes through the app's own `navigate`, and still opens in a new tab. */
export function AppLink({
  to,
  children,
  className = 'text-accent underline-offset-4 hover:underline',
  dir,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  dir?: 'ltr';
}) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      className={className}
      {...(dir === undefined ? {} : { dir })}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * A request manufacturing refused, in words (ADR-0012), with this area's own
 * wording where a code means more here (an archived component, a supplier of
 * an item to buy). `extra` goes under the message, such as what was short.
 */
export function ManufacturingFailure({
  error,
  onRetry,
  onReload,
  extra,
  forbidden,
}: {
  error: unknown;
  /** What a 403 means here, when it means more than "not allowed". */
  forbidden?: string;
  onRetry?: () => void;
  /** Offered for a change somebody else made first. */
  onReload?: () => void;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const code = error instanceof ApiRequestError ? error.code : undefined;
  return (
    <Failure
      error={error}
      onRetry={onRetry}
      overrides={{
        item_archived: t('manufacturing.errors.item_archived'),
        supplier_inactive: t('manufacturing.errors.supplier_inactive'),
        ...(forbidden === undefined ? {} : { forbidden }),
      }}
      actions={
        onReload !== undefined && (code === 'version_conflict' || code === 'already_drafted') ? (
          <button type="button" className={buttonClass.secondary} onClick={onReload}>
            {t('manufacturing.reload')}
          </button>
        ) : undefined
      }
    >
      {extra}
    </Failure>
  );
}

/** Why a manufacturing screen shows nothing: the module is off, or the seat may not read it. */
export function ManufacturingGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const seat = useManufacturingSeat();
  if (seat.me.isPending) {
    return <Loading />;
  }
  if (seat.me.isError) {
    return <Failure error={seat.me.error} onRetry={() => void seat.me.refetch()} />;
  }
  if (!seat.enabled || !seat.read) {
    return (
      <p
        role="status"
        className="rounded-lg border border-border-subtle bg-surface-muted p-4 text-start text-sm text-content"
      >
        {seat.enabled ? t('errors.forbidden') : t('manufacturing.notEnabled')}
      </p>
    );
  }
  return <>{children}</>;
}

/** Finds an item that has a bill of materials in use, by SKU or name. */
export function BomItemPicker({
  value,
  onChange,
  label,
}: {
  value: BomRow['item'] | null;
  onChange: (item: BomRow['item'] | null) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const found = useQuery({
    queryKey: keys.boms({ q: searched, pageSize: 10 }),
    queryFn: async () =>
      (
        await client.GET('/v1/manufacturing/boms', {
          params: { query: { ...(searched === '' ? {} : { q: searched! }), pageSize: 10 } },
        })
      ).data!.items,
    enabled: searched !== null,
  });

  if (value !== null) {
    return (
      <Field label={label}>
        {(id) => (
          <div className="flex items-center gap-2">
            <output id={id} className="flex-1 text-sm text-content">
              <span dir="ltr" className="text-content-muted">
                {value.sku}
              </span>{' '}
              {value.name}
            </output>
            <button type="button" className={buttonClass.ghost} onClick={() => onChange(null)}>
              {t('manufacturing.orders.changeItem')}
            </button>
          </div>
        )}
      </Field>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={t('manufacturing.orders.itemHint')}>
        {(id, describedBy) => (
          <div className="flex gap-2">
            <input
              id={id}
              aria-describedby={describedBy}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  setSearched(text.trim());
                }
              }}
            />
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setSearched(text.trim())}
            >
              {t('manufacturing.orders.findItem')}
            </button>
          </div>
        )}
      </Field>
      {searched === null ? null : found.isPending ? (
        <Loading />
      ) : found.isError ? (
        <Failure error={found.error} onRetry={() => void found.refetch()} />
      ) : found.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('manufacturing.orders.noItems')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {found.data.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="w-full rounded-md p-2 text-start text-sm text-content hover:bg-surface-muted"
                onClick={() => onChange(row.item)}
              >
                <span dir="ltr" className="text-content-muted">
                  {row.item.sku}
                </span>{' '}
                {row.item.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A label and its value, in a definition list. */
export function Detail({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-content-muted">{label}</dt>
      <dd className="break-words text-content">{children ?? t('inventory.items.none')}</dd>
    </div>
  );
}
