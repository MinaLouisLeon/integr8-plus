import { ApiRequestError } from '@integr8/api-client';
import { localToday } from '@integr8/form-renderer-dom/screens';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ItemRow, keys, type SupplierPrice, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { formatQuantity, ItemPicker, useUnitName } from '../inventory/inventory-parts.js';
import {
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  InlineError,
  Loading,
  usePermissions,
} from '../ui.js';
import {
  isPositiveQuantity,
  isQuantity,
  QUANTITY_PATTERN,
  seesPrices,
  useIdempotencyKey,
  useSuppliers,
} from './purchasing-parts.js';

/**
 * Supplier price lists (eighth round; ADR-0012): a price per supplier and
 * item, in the supplier's currency, from a quantity on, between two days. A
 * new purchase order line takes the price in force for its quantity. Only
 * those who see prices — who manage purchasing or move stock — read them.
 */

function usePrices(query: { supplierId: string } | { itemId: string }, enabled: boolean) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.supplierPrices(query),
    queryFn: async () =>
      (await client.GET('/v1/purchasing/prices', { params: { query } })).data!.items,
    enabled,
  });
}

/** The days a price holds: from one day, to another or open-ended. */
function useValidity(): (price: Pick<SupplierPrice, 'validFrom' | 'validTo'>) => string {
  const { t } = useTranslation();
  const { locale } = useOperations();
  return (price) =>
    price.validTo === null
      ? t('purchasing.prices.fromOn', { from: formatDate(price.validFrom, { locale }) })
      : t('purchasing.prices.between', {
          from: formatDate(price.validFrom, { locale }),
          to: formatDate(price.validTo, { locale }),
        });
}

/** The "Price list" section of a supplier: every price, with add, change and remove. */
export function SupplierPriceList({
  supplierId,
  canManage,
}: {
  supplierId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const permissions = usePermissions();
  const unitName = useUnitName();
  const validity = useValidity();
  const visible = seesPrices(permissions);
  const prices = usePrices({ supplierId }, visible);
  const [editing, setEditing] = useState<SupplierPrice | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: async (priceId: string) =>
      client.DELETE('/v1/purchasing/prices/{priceId}', { params: { path: { priceId } } }),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['purchasing', 'prices'] });
    },
  });

  if (!visible) {
    return null;
  }
  const hidden = prices.error instanceof ApiRequestError && prices.error.code === 'prices_hidden';
  if (hidden) {
    return null;
  }

  return (
    <section aria-labelledby="purchasing-supplier-prices" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="purchasing-supplier-prices" className="text-base font-semibold text-content">
          {t('purchasing.prices.title')}
        </h2>
        {canManage ? (
          <button type="button" className={buttonClass.secondary} onClick={() => setEditing('new')}>
            {t('purchasing.prices.add')}
          </button>
        ) : null}
      </div>
      <p className="text-sm text-content-muted">{t('purchasing.prices.intro')}</p>
      {prices.isPending ? (
        <Loading />
      ) : prices.isError ? (
        <Failure error={prices.error} onRetry={() => void prices.refetch()} />
      ) : prices.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('purchasing.prices.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-content-muted">
              <tr>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('purchasing.prices.item')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('purchasing.prices.currency')}
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  {t('purchasing.prices.minQuantity')}
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  {t('purchasing.prices.unitPrice')}
                </th>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('purchasing.prices.valid')}
                </th>
                {canManage ? (
                  <th scope="col" className="py-1">
                    <span className="sr-only">{t('purchasing.prices.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {prices.data.map((price) => (
                <tr key={price.id}>
                  <td className="py-2">
                    <a
                      href={paths.item(price.item.id)}
                      className="text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.item(price.item.id));
                      }}
                    >
                      {price.item.name}
                    </a>
                    <span dir="ltr" className="ms-2 text-content-muted">
                      {price.item.sku}
                    </span>
                  </td>
                  <td className="py-2" dir="ltr">
                    {price.currencyCode}
                  </td>
                  <td className="py-2 text-end tabular-nums">
                    {formatQuantity(price.minQuantity, price.item.unit, locale, unitName)}
                  </td>
                  <td className="py-2 text-end tabular-nums">
                    {formatAmount(price.unitPrice, price.currencyCode, locale)}
                  </td>
                  <td className="py-2">{validity(price)}</td>
                  {canManage ? (
                    <td className="py-2 text-end whitespace-nowrap">
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        aria-label={t('purchasing.prices.editNamed', { item: price.item.name })}
                        onClick={() => setEditing(price)}
                      >
                        {t('purchasing.prices.edit')}
                      </button>
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        aria-label={t('purchasing.prices.removeNamed', { item: price.item.name })}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t('purchasing.prices.removeConfirm'))) {
                            remove.mutate(price.id);
                          }
                        }}
                      >
                        {t('purchasing.prices.remove')}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remove.isError ? <Failure error={remove.error} /> : null}
      {editing === null ? null : (
        <PriceDialog
          supplierId={supplierId}
          price={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

interface PriceDraft {
  item: Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'> | null;
  currencyCode: string;
  minQuantity: string;
  unitPrice: string;
  validFrom: string;
  validTo: string;
}

/** Adds a price to a supplier's list, or changes one (its item stays). */
function PriceDialog({
  supplierId,
  price,
  onClose,
}: {
  supplierId: string;
  price: SupplierPrice | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
    enabled: price === null,
  });
  const [draft, setDraft] = useState<PriceDraft>(() =>
    price === null
      ? {
          item: null,
          currencyCode: '',
          minQuantity: '1',
          unitPrice: '',
          validFrom: localToday(),
          validTo: '',
        }
      : {
          item: price.item,
          currencyCode: price.currencyCode,
          minQuantity: price.minQuantity,
          unitPrice: price.unitPrice,
          validFrom: price.validFrom,
          validTo: price.validTo ?? '',
        },
  );
  const currencyCode =
    draft.currencyCode === '' ? (settings.data?.currency ?? '') : draft.currencyCode;
  const body = {
    currencyCode: currencyCode.trim().toUpperCase(),
    minQuantity: draft.minQuantity.trim(),
    unitPrice: draft.unitPrice.trim(),
    validFrom: draft.validFrom,
    validTo: draft.validTo === '' ? null : draft.validTo,
  };
  const idempotencyKey = useIdempotencyKey({ ...body, itemId: draft.item?.id ?? null });
  const ready =
    draft.item !== null &&
    /^[A-Z]{3}$/u.test(body.currencyCode) &&
    isPositiveQuantity(body.minQuantity) &&
    isQuantity(body.unitPrice) &&
    body.validFrom !== '' &&
    (body.validTo === null || body.validTo >= body.validFrom);

  const save = useMutation({
    mutationFn: async () =>
      price === null
        ? (
            await client.POST('/v1/purchasing/suppliers/{supplierId}/prices', {
              params: {
                path: { supplierId },
                header: { 'Idempotency-Key': idempotencyKey },
              },
              body: { ...body, itemId: draft.item!.id },
            })
          ).data!
        : (
            await client.PUT('/v1/purchasing/prices/{priceId}', {
              params: { path: { priceId: price.id } },
              body,
            })
          ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['purchasing', 'prices'] });
      onClose();
    },
  });
  const set = <K extends keyof PriceDraft>(key: K, value: PriceDraft[K]) => {
    save.reset();
    setDraft({ ...draft, [key]: value });
  };

  return (
    <Dialog
      title={price === null ? t('purchasing.prices.addTitle') : t('purchasing.prices.editTitle')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('purchasing.orders.cancel')}
          </button>
          <button
            type="submit"
            form="purchasing-price"
            className={buttonClass.primary}
            disabled={!ready || save.isPending}
          >
            {save.isPending ? t('purchasing.prices.saving') : t('purchasing.prices.save')}
          </button>
        </>
      }
    >
      <form
        id="purchasing-price"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            save.mutate();
          }
        }}
      >
        <div className="sm:col-span-2">
          {price === null ? (
            <ItemPicker
              label={t('purchasing.prices.item')}
              value={draft.item}
              onChange={(item) => set('item', item)}
              kinds={['stock_item', 'non_stock_item']}
            />
          ) : (
            <p className="text-sm text-content">
              <span className="text-content-muted">{t('purchasing.prices.item')}: </span>
              {price.item.name}
            </p>
          )}
        </div>
        <Field label={t('purchasing.prices.currency')} hint={t('purchasing.prices.currencyHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              required
              dir="ltr"
              maxLength={3}
              autoCapitalize="characters"
              aria-describedby={describedBy}
              className={inputClass}
              value={currencyCode}
              onChange={(event) => set('currencyCode', event.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field
          label={t('purchasing.prices.minQuantity')}
          hint={t('purchasing.prices.minQuantityHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              required
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY_PATTERN}
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.minQuantity}
              onChange={(event) => set('minQuantity', event.target.value.trim())}
            />
          )}
        </Field>
        <Field label={t('purchasing.prices.unitPrice')}>
          {(id) => (
            <input
              id={id}
              required
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY_PATTERN}
              className={inputClass}
              value={draft.unitPrice}
              onChange={(event) => set('unitPrice', event.target.value.trim())}
            />
          )}
        </Field>
        <div aria-hidden="true" className="hidden sm:block" />
        <Field label={t('purchasing.prices.validFrom')}>
          {(id) => (
            <input
              id={id}
              required
              type="date"
              dir="ltr"
              className={inputClass}
              value={draft.validFrom}
              onChange={(event) => set('validFrom', event.target.value)}
            />
          )}
        </Field>
        <Field label={t('purchasing.prices.validTo')} hint={t('purchasing.prices.validToHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              min={draft.validFrom}
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.validTo}
              onChange={(event) => set('validTo', event.target.value)}
            />
          )}
        </Field>
        {save.isError ? (
          <div className="sm:col-span-2">
            <Failure
              error={save.error}
              overrides={{ price_overlaps: t('purchasing.prices.overlaps') }}
            />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * An item's prices from every supplier, to read. Shown only to seats that
 * see prices; a seat the server says may not (`prices_hidden`) sees nothing.
 */
export function ItemSupplierPrices({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const { locale, paths, navigate } = useOperations();
  const permissions = usePermissions();
  const unitName = useUnitName();
  const validity = useValidity();
  const visible = seesPrices(permissions) && permissions.includes('purchasing.read');
  const prices = usePrices({ itemId }, visible);
  const suppliers = useSuppliers(true, visible);
  if (!visible) {
    return null;
  }
  if (
    prices.error instanceof ApiRequestError &&
    (prices.error.code === 'prices_hidden' || prices.error.status === 403)
  ) {
    return null;
  }
  const supplierName = new Map((suppliers.data ?? []).map((row) => [row.id, row.name]));

  return (
    <section aria-labelledby="inventory-item-prices" className={cardClass}>
      <h2 id="inventory-item-prices" className="text-base font-semibold text-content">
        {t('purchasing.prices.itemTitle')}
      </h2>
      {prices.isPending ? (
        <Loading />
      ) : prices.isError ? (
        <InlineError onRetry={() => void prices.refetch()} />
      ) : prices.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('purchasing.prices.itemEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {prices.data.map((price) => (
            <li key={price.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <a
                href={paths.supplier(price.supplierId)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.supplier(price.supplierId));
                }}
              >
                {supplierName.get(price.supplierId) ?? t('purchasing.prices.aSupplier')}
              </a>
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-content tabular-nums">
                  {formatAmount(price.unitPrice, price.currencyCode, locale)}
                </span>
                <span className="text-xs text-content-muted tabular-nums">
                  {t('purchasing.prices.fromQuantity', {
                    quantity: formatQuantity(price.minQuantity, price.item.unit, locale, unitName),
                  })}
                </span>
                <span className="text-xs text-content-muted">{validity(price)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
