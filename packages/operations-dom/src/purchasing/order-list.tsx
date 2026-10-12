import { PURCHASE_ORDER_STATUSES } from '@integr8/core';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type ItemRow,
  keys,
  type PurchaseOrderLine,
  type PurchaseOrderStatus,
  useOperations,
} from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { fieldDetail } from '../field-errors.js';
import { ItemPicker, useLocations } from '../inventory/inventory-parts.js';
import {
  BackLink,
  buttonClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import {
  basisPointsOfPercent,
  isPositiveQuantity,
  isQuantity,
  OrderStatusBadge,
  percentOfBasisPoints,
  QUANTITY_PATTERN,
  useActiveSuppliers,
} from './purchasing-parts.js';
import { ReorderLocationDialog } from './reorder-screen.js';

/**
 * Purchase orders (CRM/ERP plan, phase E2): what is on order with whom, by
 * status, and the dialog that drafts a new one. The line editor here is the
 * one the order screen uses to change a draft.
 */

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

type PickedItem = Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'>;

export interface LineDraft {
  key: string;
  item: PickedItem | null;
  description: string;
  quantity: string;
  unitPrice: string;
  /** A percentage as typed, such as `14` or `14.5`; empty for none. */
  taxPercent: string;
}

export const newLineDraft = (): LineDraft => ({
  key: crypto.randomUUID(),
  item: null,
  description: '',
  quantity: '',
  unitPrice: '',
  taxPercent: '',
});

export function lineDraftsOf(lines: readonly PurchaseOrderLine[]): LineDraft[] {
  return lines.map((line) => ({
    key: line.id,
    item: line.item,
    description: line.description,
    quantity: line.quantityOrdered,
    unitPrice: line.unitPrice ?? '',
    taxPercent: line.taxRateBp === 0 ? '' : percentOfBasisPoints(line.taxRateBp),
  }));
}

/**
 * A line is ready with an item and a quantity. The unit price may be left
 * blank: the supplier's price list then gives the one in force (ADR-0012).
 */
export const lineDraftValid = (line: LineDraft) =>
  line.item !== null &&
  isPositiveQuantity(line.quantity) &&
  (line.unitPrice.trim() === '' || isQuantity(line.unitPrice)) &&
  (line.taxPercent.trim() === '' || basisPointsOfPercent(line.taxPercent) !== undefined);

/** The request lines the drafts stand for; only call once every draft is valid. */
export function lineBodiesOf(lines: readonly LineDraft[]) {
  return lines.map((line) => ({
    itemId: line.item!.id,
    ...(line.description.trim() === '' ? {} : { description: line.description.trim() }),
    quantityOrdered: line.quantity.trim(),
    ...(line.unitPrice.trim() === '' ? {} : { unitPrice: line.unitPrice.trim() }),
    ...(line.taxPercent.trim() === '' ? {} : { taxRateBp: basisPointsOfPercent(line.taxPercent)! }),
  }));
}

export function LinesEditor({
  lines,
  onChange,
  error,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  /** The last refusal of these lines: a line the supplier has no price for is marked on it. */
  error?: unknown;
}) {
  const { t } = useTranslation();
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const priceRequired = (index: number) =>
    fieldDetail(error, `body.lines.${index}.unitPrice`)?.code === 'price_required';
  return (
    <div className="flex flex-col gap-3">
      {lines.length === 0 ? (
        <p className="text-sm text-content-muted">{t('purchasing.orders.noLines')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {lines.map((line, index) => (
            <li
              key={line.key}
              aria-label={`${t('purchasing.orders.lines')} ${index + 1}`}
              className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3"
            >
              <ItemPicker
                label={t('purchasing.orders.item')}
                value={line.item}
                onChange={(item) =>
                  update(line.key, {
                    item,
                    description:
                      line.description === '' || line.description === line.item?.name
                        ? (item?.name ?? '')
                        : line.description,
                  })
                }
              />
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label={t('purchasing.orders.description')} className="sm:col-span-4">
                  {(id) => (
                    <input
                      id={id}
                      maxLength={500}
                      className={inputClass}
                      value={line.description}
                      onChange={(event) => update(line.key, { description: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label={t('purchasing.orders.quantity')}
                  {...(line.item === null ? {} : { hint: t(`inventory.unit.${line.item.unit}`) })}
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
                      value={line.quantity}
                      onChange={(event) =>
                        update(line.key, { quantity: event.target.value.trim() })
                      }
                    />
                  )}
                </Field>
                <Field
                  label={t('purchasing.orders.unitPrice')}
                  hint={
                    priceRequired(index) && line.unitPrice.trim() === ''
                      ? t('purchasing.lines.priceRequired')
                      : t('purchasing.lines.unitPriceHint')
                  }
                >
                  {(id, describedBy) => (
                    <input
                      id={id}
                      inputMode="decimal"
                      dir="ltr"
                      pattern={QUANTITY_PATTERN}
                      aria-describedby={describedBy}
                      aria-invalid={priceRequired(index) && line.unitPrice.trim() === ''}
                      className={inputClass}
                      value={line.unitPrice}
                      onChange={(event) =>
                        update(line.key, { unitPrice: event.target.value.trim() })
                      }
                    />
                  )}
                </Field>
                <Field label={t('purchasing.orders.taxRate')}>
                  {(id) => (
                    <input
                      id={id}
                      inputMode="decimal"
                      dir="ltr"
                      pattern={String.raw`\d{1,3}(\.\d{1,2})?`}
                      className={inputClass}
                      value={line.taxPercent}
                      onChange={(event) =>
                        update(line.key, { taxPercent: event.target.value.trim() })
                      }
                    />
                  )}
                </Field>
                <div className="flex items-end">
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() =>
                      onChange(lines.filter((candidate) => candidate.key !== line.key))
                    }
                  >
                    {t('purchasing.orders.removeLine')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className={`${buttonClass.secondary} self-start`}
        onClick={() => onChange([...lines, newLineDraft()])}
      >
        {t('purchasing.orders.addLine')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New order
// ---------------------------------------------------------------------------

/** Drafts an order, with the supplier fixed when opened from one. */
export function NewOrderDialog({
  supplier,
  onClose,
}: {
  supplier?: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const suppliers = useActiveSuppliers();
  const locations = useLocations();
  const [supplierId, setSupplierId] = useState(supplier?.id ?? '');
  const [expectedDate, setExpectedDate] = useState('');
  const [locationId, setLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const ready = supplierId !== '' && lines.every(lineDraftValid);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/purchasing/orders', {
          body: {
            supplierId,
            ...(expectedDate === '' ? {} : { expectedDate }),
            ...(locationId === '' ? {} : { deliveryLocationId: locationId }),
            ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
            lines: lineBodiesOf(lines),
          },
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['purchasing'] });
      navigate(paths.purchaseOrder(created.order.id));
    },
  });

  return (
    <Dialog
      title={t('purchasing.orders.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('purchasing.orders.cancel')}
          </button>
          <button
            type="submit"
            form="purchasing-new-order"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('purchasing.orders.creating') : t('purchasing.orders.create')}
          </button>
        </>
      }
    >
      <form
        id="purchasing-new-order"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('purchasing.orders.supplier')}>
            {(id) =>
              supplier === undefined ? (
                <select
                  id={id}
                  required
                  className={inputClass}
                  value={supplierId}
                  onChange={(event) => setSupplierId(event.target.value)}
                >
                  <option value="">{t('purchasing.orders.chooseSupplier')}</option>
                  {(suppliers.data ?? []).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              ) : (
                <output id={id} className="text-sm text-content">
                  {supplier.name}
                </output>
              )
            }
          </Field>
          <Field label={t('purchasing.orders.expectedDate')}>
            {(id) => (
              <input
                id={id}
                type="date"
                dir="ltr"
                className={inputClass}
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('purchasing.orders.deliveryLocation')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{t('purchasing.orders.chooseLocation')}</option>
                {(locations.data ?? []).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('purchasing.orders.notes')}>
            {(id) => (
              <input
                id={id}
                maxLength={10_000}
                className={inputClass}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            )}
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-content">
            {t('purchasing.orders.lines')}
          </legend>
          <LinesEditor lines={lines} onChange={setLines} error={create.error} />
        </fieldset>
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function OrderListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [status, setStatus] = useState<PurchaseOrderStatus | ''>('');
  const [creating, setCreating] = useState(false);
  const [reordering, setReordering] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const canManage = me.data?.permissions.includes('purchasing.manage') ?? false;

  const query = {
    ...(searched === '' ? {} : { q: searched }),
    ...(status === '' ? {} : { status: [status] }),
    limit: 50,
  };
  const orders = useInfiniteQuery({
    queryKey: keys.purchaseOrders(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/purchasing/orders', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = orders.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('purchasing.orders.title')}</h1>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setReordering(true)}
            >
              {t('purchasing.reorder.title')}
            </button>
            <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}>
              {t('purchasing.orders.new')}
            </button>
          </div>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(text.trim());
        }}
      >
        <Field label={t('purchasing.orders.search')} className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('purchasing.orders.anyStatus')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as PurchaseOrderStatus | '')}
            >
              <option value="">{t('purchasing.orders.anyStatus')}</option>
              {PURCHASE_ORDER_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`purchasing.status.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('inventory.items.apply')}
        </button>
      </form>

      {orders.isPending ? (
        <Loading />
      ) : orders.isError ? (
        <Failure error={orders.error} onRetry={() => void orders.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' && status === ''
            ? t('purchasing.orders.emptyAll')
            : t('purchasing.orders.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'purchaseOrder', id: order.id, label: order.reference },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.purchaseOrder(order.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <a
                      href={paths.purchaseOrder(order.id)}
                      dir="ltr"
                      className="font-medium text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.purchaseOrder(order.id));
                      }}
                    >
                      {order.reference}
                    </a>
                    <OrderStatusBadge status={order.status} />
                  </span>
                  <span className="truncate text-sm text-content-muted">{order.supplier.name}</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-content-muted tabular-nums">
                  {order.expectedDate === null ? null : (
                    <span>
                      {t('purchasing.orders.expectedDate')}:{' '}
                      {formatDate(order.expectedDate, { locale })}
                    </span>
                  )}
                  {order.totals === null ? null : (
                    <span className="text-content">
                      {formatAmount(order.totals.total, order.currencyCode, locale)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {orders.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={orders.isFetchingNextPage}
              onClick={() => void orders.fetchNextPage()}
            >
              {t('purchasing.orders.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {creating ? <NewOrderDialog onClose={() => setCreating(false)} /> : null}
      {reordering ? <ReorderLocationDialog onClose={() => setReordering(false)} /> : null}
    </div>
  );
}
