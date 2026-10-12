import { ASSEMBLY_DIRECTIONS, ASSEMBLY_ORDER_STATUSES } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type AssemblyDirection,
  type AssemblyOrderStatus,
  type BomRow,
  keys,
  useOperations,
} from '../api.js';
import { formatQuantity, useLocations, useUnitName } from '../inventory/inventory-parts.js';
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
  AppLink,
  AssemblyStatusBadge,
  BomItemPicker,
  DirectionBadge,
  isPositiveQuantity,
  ManufacturingFailure,
  ManufacturingGate,
  QUANTITY_PATTERN,
  useManufacturingSeat,
} from './manufacturing-parts.js';

/**
 * Assembly and disassembly orders (seventh round; ADR-0011): by status, found
 * by their number, and the dialog that drafts one from an item's bill.
 */
export function AssemblyOrderListScreen() {
  return (
    <ManufacturingGate>
      <AssemblyOrderList />
    </ManufacturingGate>
  );
}

function AssemblyOrderList() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const seat = useManufacturingSeat();
  const unitName = useUnitName();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<AssemblyOrderStatus | ''>('');
  const [applied, setApplied] = useState<{ q: string; status: AssemblyOrderStatus | '' }>({
    q: '',
    status: '',
  });
  const [creating, setCreating] = useState(false);

  const query = {
    ...(applied.q === '' ? {} : { q: applied.q }),
    ...(applied.status === '' ? {} : { status: [applied.status] }),
    limit: 50,
  };
  const orders = useInfiniteQuery({
    queryKey: keys.assemblyOrders(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/manufacturing/orders', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = orders.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = applied.q !== '' || applied.status !== '';

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('manufacturing.orders.title')}</h1>
        {seat.manage ? (
          <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}>
            {t('manufacturing.orders.new')}
          </button>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ q: text.trim(), status });
        }}
      >
        <Field
          label={t('manufacturing.orders.search')}
          hint={t('manufacturing.orders.searchHint')}
          className="min-w-64 flex-1"
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="search"
              dir="ltr"
              aria-describedby={describedBy}
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('manufacturing.orders.status')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as AssemblyOrderStatus | '')}
            >
              <option value="">{t('manufacturing.orders.anyStatus')}</option>
              {ASSEMBLY_ORDER_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`manufacturing.status.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('manufacturing.orders.apply')}
        </button>
      </form>

      {orders.isPending ? (
        <Loading />
      ) : orders.isError ? (
        <ManufacturingFailure error={orders.error} onRetry={() => void orders.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('manufacturing.orders.empty') : t('manufacturing.orders.emptyAll')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'assemblyOrder', id: order.id, label: order.reference },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.assemblyOrder(order.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <AppLink
                      to={paths.assemblyOrder(order.id)}
                      dir="ltr"
                      className="font-medium text-accent underline-offset-4 hover:underline"
                    >
                      {order.reference}
                    </AppLink>
                    <AssemblyStatusBadge status={order.status} />
                    <DirectionBadge direction={order.direction} />
                  </span>
                  <span className="truncate text-sm text-content-muted">{order.item.name}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted tabular-nums">
                  <span className="text-content">
                    {t('manufacturing.orders.line', {
                      quantity: formatQuantity(order.quantity, order.item.unit, locale, unitName),
                      location: order.location.name,
                    })}
                  </span>
                  {order.plannedFor === null ? null : (
                    <span>
                      {t('manufacturing.orders.plannedFor')}:{' '}
                      {formatCalendarDate(order.plannedFor, { locale })}
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
              {t('manufacturing.orders.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {creating ? <NewAssemblyOrderDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/**
 * Drafts an assembly or disassembly order from an item's bill in use, with
 * the item fixed when opened from its bill. One idempotency key per distinct
 * request, so a retry replays rather than drafts twice.
 */
export function NewAssemblyOrderDialog({
  item,
  onClose,
}: {
  item?: BomRow['item'];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const locations = useLocations();
  const [direction, setDirection] = useState<AssemblyDirection>('assemble');
  const [chosen, setChosen] = useState<BomRow['item'] | null>(item ?? null);
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [plannedFor, setPlannedFor] = useState('');
  const [note, setNote] = useState('');

  const body =
    chosen === null
      ? null
      : {
          direction,
          itemId: chosen.id,
          locationId,
          quantity: quantity.trim(),
          ...(plannedFor === '' ? {} : { plannedFor }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        };
  const bodyText = JSON.stringify(body);
  const idempotencyKey = useMemo(
    () => (bodyText === 'null' ? '' : crypto.randomUUID()),
    [bodyText],
  );
  const ready = body !== null && locationId !== '' && isPositiveQuantity(quantity);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/manufacturing/orders', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: body!,
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['manufacturing'] });
      navigate(paths.assemblyOrder(created.id));
    },
  });

  return (
    <Dialog
      title={t('manufacturing.orders.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('manufacturing.orders.cancel')}
          </button>
          <button
            type="submit"
            form="manufacturing-new-order"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending
              ? t('manufacturing.orders.creating')
              : t('manufacturing.orders.create')}
          </button>
        </>
      }
    >
      <form
        id="manufacturing-new-order"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        <fieldset className="flex flex-wrap gap-4 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium text-content">
            {t('manufacturing.orders.direction')}
          </legend>
          {ASSEMBLY_DIRECTIONS.map((candidate) => (
            <label key={candidate} className="flex items-center gap-2 text-sm text-content">
              <input
                type="radio"
                name="manufacturing-direction"
                value={candidate}
                checked={direction === candidate}
                onChange={() => setDirection(candidate)}
              />
              {t(`manufacturing.direction.${candidate}`)}
            </label>
          ))}
          <p className="w-full text-xs text-content-muted">
            {t(`manufacturing.orders.directionHint.${direction}`)}
          </p>
        </fieldset>
        <div className="sm:col-span-2">
          {item === undefined ? (
            <BomItemPicker
              label={t('manufacturing.orders.item')}
              value={chosen}
              onChange={setChosen}
            />
          ) : (
            <p className="text-sm text-content">
              <span className="text-content-muted">{t('manufacturing.orders.item')}: </span>
              {item.name}
            </p>
          )}
        </div>
        <Field label={t('manufacturing.orders.location')}>
          {(id) => (
            <select
              id={id}
              required
              className={inputClass}
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            >
              <option value="">{t('manufacturing.orders.chooseLocation')}</option>
              {(locations.data ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('manufacturing.orders.quantity')}>
          {(id) => (
            <input
              id={id}
              required
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY_PATTERN}
              className={inputClass}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.trim())}
            />
          )}
        </Field>
        <Field label={t('manufacturing.orders.plannedFor')}>
          {(id) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              className={inputClass}
              value={plannedFor}
              onChange={(event) => setPlannedFor(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('manufacturing.orders.note')}>
          {(id) => (
            <input
              id={id}
              maxLength={1000}
              className={inputClass}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
        {locations.isError ? (
          <div className="sm:col-span-2">
            <Failure error={locations.error} onRetry={() => void locations.refetch()} />
          </div>
        ) : null}
        {create.isError ? (
          <div className="sm:col-span-2">
            <ManufacturingFailure error={create.error} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
