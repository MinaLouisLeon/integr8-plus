import { ITEM_KINDS, LOCATION_KINDS, UNITS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type ItemKind,
  type ItemRow,
  keys,
  type StockLocation,
  type Unit,
  useOperations,
} from '../api.js';
import { buttonClass, Dialog, Failure, Field, inputClass, Loading } from '../ui.js';

/**
 * Pieces the inventory screens share (CRM/ERP plan, phase E1): quantities and
 * units in words, badges, the company's locations and categories, an item
 * picker, and the dialog that moves stock.
 */

/** A quantity as a decimal string, never a float, with its unit. */
export function formatQuantity(
  value: string,
  unit: Unit | undefined,
  locale: string,
  unitName: (unit: Unit) => string,
): string {
  let amount: string;
  try {
    amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
      value as unknown as number,
    );
  } catch {
    amount = value;
  }
  return unit === undefined ? amount : `${amount} ${unitName(unit)}`;
}

export function useUnitName(): (unit: Unit) => string {
  const { t } = useTranslation();
  return (unit) => t(`inventory.unit.${unit}`);
}

const KIND_STYLE: Record<ItemKind, string> = {
  stock_item: 'border-accent bg-surface text-content',
  non_stock_item: 'border-border-subtle bg-surface-muted text-content',
  service: 'border-border-subtle bg-surface-muted text-content-muted',
};

export function KindBadge({ kind }: { kind: ItemKind }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${KIND_STYLE[kind]}`}
    >
      {t(`inventory.kind.${kind}`)}
    </span>
  );
}

export function LocationKindBadge({ kind }: { kind: StockLocation['kind'] }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
      {t(`inventory.locationKind.${kind}`)}
    </span>
  );
}

export { ITEM_KINDS, LOCATION_KINDS, UNITS };

export type LocationOwnership = StockLocation['ownership'];

/**
 * Said beside a site location that records the customer's own stock: never
 * counted in ours, valued, planned from or delivered from (ADR-0012). Our
 * stock carries no badge — it is the usual case.
 */
export function OwnershipBadge({ ownership }: { ownership: LocationOwnership }) {
  const { t } = useTranslation();
  if (ownership !== 'customer') {
    return null;
  }
  return (
    <span className="inline-flex items-center rounded-full border border-warning bg-warning-subtle px-2 py-0.5 text-xs font-medium text-content">
      {t('inventory.ownership.customerBadge')}
    </span>
  );
}

/** Whose stock a site location holds, each choice explained in one line. Sites only. */
export function OwnershipChoice({
  value,
  onChange,
  disabled = false,
  name,
}: {
  value: LocationOwnership;
  onChange: (ownership: LocationOwnership) => void;
  disabled?: boolean;
  /** The radio group's name, unique on the page. */
  name: string;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-content">
        {t('inventory.ownership.label')}
      </legend>
      {(['ours', 'customer'] as const).map((choice) => (
        <div key={choice} className="flex items-start gap-2 text-sm text-content">
          <input
            id={`${name}-${choice}`}
            type="radio"
            name={name}
            className="mt-1"
            checked={value === choice}
            onChange={() => onChange(choice)}
            aria-describedby={`${name}-${choice}-hint`}
          />
          <span className="flex flex-col">
            <label htmlFor={`${name}-${choice}`} className="font-medium">
              {t(`inventory.ownership.${choice}`)}
            </label>
            <span id={`${name}-${choice}-hint`} className="text-xs text-content-muted">
              {t(`inventory.ownership.${choice}Hint`)}
            </span>
          </span>
        </div>
      ))}
    </fieldset>
  );
}

export function useCategories() {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.categories,
    queryFn: async () => (await client.GET('/v1/inventory/categories')).data!.items,
  });
}

export function useLocations(includeArchived = false) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.stockLocations({ includeArchived }),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/locations', {
          params: { query: includeArchived ? { includeArchived: 'true' } : {} },
        })
      ).data!.items,
  });
}

/** Finds a stock item by SKU, name or barcode. */
export function ItemPicker({
  value,
  onChange,
  label,
  hint,
  kinds = ['stock_item'],
}: {
  value: Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'> | null;
  onChange: (item: ItemRow | null) => void;
  label: string;
  hint?: string;
  /** Which kinds to offer; stock items only unless said otherwise. */
  kinds?: readonly ItemKind[];
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const found = useQuery({
    queryKey: keys.items({ q: searched, kind: kinds, limit: 10 }),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/items', {
          params: { query: { q: searched, kind: [...kinds], limit: 10 } },
        })
      ).data!.items,
    enabled: searched !== '',
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
              {t('inventory.move.changeItem')}
            </button>
          </div>
        )}
      </Field>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} {...(hint === undefined ? {} : { hint })}>
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
              {t('inventory.move.search')}
            </button>
          </div>
        )}
      </Field>
      {searched === '' ? null : found.isPending ? (
        <Loading />
      ) : found.isError ? (
        <Failure error={found.error} onRetry={() => void found.refetch()} />
      ) : found.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('inventory.move.noResults')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {found.data.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="w-full rounded-md p-2 text-start text-sm text-content hover:bg-surface-muted"
                onClick={() => onChange(item)}
              >
                <span dir="ltr" className="text-content-muted">
                  {item.sku}
                </span>{' '}
                {item.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type MoveType = 'receipt' | 'issue' | 'transfer' | 'adjustment';

/**
 * Receive, issue, transfer or adjust stock. Opened from an item (item fixed),
 * a location (location fixed) or the overview (both chosen here). One
 * idempotency key per distinct request, so a retry replays rather than moves
 * twice.
 */
export function MoveStockDialog({
  item,
  location,
  canSeeCosts,
  onClose,
}: {
  item?: Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'>;
  location?: Pick<StockLocation, 'id' | 'name'>;
  canSeeCosts: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const locations = useLocations();
  const unitName = useUnitName();
  const [type, setType] = useState<MoveType>('receipt');
  const [chosenItem, setChosenItem] = useState(item ?? null);
  const [locationId, setLocationId] = useState(location?.id ?? '');
  const [toLocationId, setToLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [reason, setReason] = useState('');

  const body =
    chosenItem === null
      ? undefined
      : type === 'transfer'
        ? {
            type,
            itemId: chosenItem.id,
            fromLocationId: locationId,
            toLocationId,
            quantity: quantity.trim(),
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          }
        : type === 'adjustment'
          ? {
              type,
              itemId: chosenItem.id,
              locationId,
              direction,
              quantity: quantity.trim(),
              reason: reason.trim(),
            }
          : type === 'issue'
            ? {
                type,
                itemId: chosenItem.id,
                locationId,
                quantity: quantity.trim(),
                reason: reason.trim(),
              }
            : {
                type,
                itemId: chosenItem.id,
                locationId,
                quantity: quantity.trim(),
                ...(unitCost.trim() === '' ? {} : { unitCost: unitCost.trim() }),
                ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
              };
  const bodyText = JSON.stringify(body ?? null);
  const idempotencyKey = useMemo(
    () => (bodyText === 'null' ? '' : crypto.randomUUID()),
    [bodyText],
  );

  const needsReason = type === 'issue' || type === 'adjustment';
  const ready =
    body !== undefined &&
    quantity.trim() !== '' &&
    locationId !== '' &&
    (type !== 'transfer' || (toLocationId !== '' && toLocationId !== locationId)) &&
    (!needsReason || reason.trim() !== '');

  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/movements', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: body!,
        })
      ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
  });

  const locationSelect = (id: string, value: string, onChange: (value: string) => void) => (
    <select
      id={id}
      className={inputClass}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t('inventory.move.chooseLocation')}</option>
      {(locations.data ?? []).map((candidate) => (
        <option key={candidate.id} value={candidate.id}>
          {candidate.ownership === 'customer'
            ? t('inventory.ownership.optionCustomer', { name: candidate.name })
            : candidate.name}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog
      title={t('inventory.move.title')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('inventory.items.cancel')}
          </button>
          <button
            type="submit"
            form="inventory-move"
            className={buttonClass.primary}
            disabled={!ready || post.isPending}
          >
            {post.isPending ? t('inventory.move.posting') : t('inventory.move.post')}
          </button>
        </>
      }
    >
      <form
        id="inventory-move"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            post.mutate();
          }
        }}
      >
        <Field label={t('inventory.move.type')} className="sm:col-span-2">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={type}
              onChange={(event) => {
                post.reset();
                setType(event.target.value as MoveType);
              }}
            >
              {(['receipt', 'issue', 'transfer', 'adjustment'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`inventory.move.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="sm:col-span-2">
          {item === undefined ? (
            <ItemPicker
              label={t('inventory.move.item')}
              value={chosenItem}
              onChange={setChosenItem}
            />
          ) : (
            <p className="text-sm text-content">
              <span className="text-content-muted">{t('inventory.move.item')}: </span>
              {item.name}
            </p>
          )}
        </div>
        <Field
          label={type === 'transfer' ? t('inventory.move.from') : t('inventory.move.location')}
        >
          {(id) =>
            location === undefined ? (
              locationSelect(id, locationId, setLocationId)
            ) : (
              <output id={id} className="text-sm text-content">
                {location.name}
              </output>
            )
          }
        </Field>
        {type === 'transfer' ? (
          <Field label={t('inventory.move.to')}>
            {(id) => locationSelect(id, toLocationId, setToLocationId)}
          </Field>
        ) : null}
        {type === 'adjustment' ? (
          <Field label={t('inventory.move.direction')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={direction}
                onChange={(event) => setDirection(event.target.value as 'in' | 'out')}
              >
                <option value="in">{t('inventory.move.in')}</option>
                <option value="out">{t('inventory.move.out')}</option>
              </select>
            )}
          </Field>
        ) : null}
        <Field
          label={t('inventory.move.quantity')}
          {...(chosenItem === null ? {} : { hint: unitName(chosenItem.unit) })}
        >
          {(id, describedBy) => (
            <input
              id={id}
              required
              inputMode="decimal"
              dir="ltr"
              pattern="\d{1,16}(\.\d{1,4})?"
              aria-describedby={describedBy}
              className={inputClass}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.trim())}
            />
          )}
        </Field>
        {type === 'receipt' && canSeeCosts ? (
          <Field label={t('inventory.move.unitCost')} hint={t('inventory.move.unitCostHint')}>
            {(id, describedBy) => (
              <input
                id={id}
                inputMode="decimal"
                dir="ltr"
                pattern="\d{1,16}(\.\d{1,4})?"
                aria-describedby={describedBy}
                className={inputClass}
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value.trim())}
              />
            )}
          </Field>
        ) : null}
        <Field
          label={t('inventory.move.reason')}
          {...(needsReason ? { hint: t('inventory.move.reasonRequired') } : {})}
          className="sm:col-span-2"
        >
          {(id, describedBy) => (
            <input
              id={id}
              required={needsReason}
              maxLength={1000}
              aria-describedby={describedBy}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {post.isError ? (
          <div className="sm:col-span-2">
            <Failure error={post.error} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
