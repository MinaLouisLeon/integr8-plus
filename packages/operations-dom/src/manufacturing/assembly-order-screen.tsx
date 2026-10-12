import { ApiRequestError } from '@integr8/api-client';
import { isZeroDecimal, multiplyDecimal } from '@integr8/core';
import { formatCalendarDate, formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type AssemblyOrderDetail, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { formatQuantity, useLocations, useUnitName } from '../inventory/inventory-parts.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import {
  AppLink,
  AssemblyStatusBadge,
  Detail,
  DirectionBadge,
  isPositiveQuantity,
  ManufacturingFailure,
  ManufacturingGate,
  QUANTITY_PATTERN,
  useCurrency,
} from './manufacturing-parts.js';

/**
 * One assembly or disassembly order (seventh round; ADR-0011): what it takes
 * out against what is there, what it makes, its costs once done, and — for
 * those who may — changing the draft, moving it to the bill now in use,
 * completing it and cancelling it.
 */
export function AssemblyOrderScreen({ orderId }: { orderId: string }) {
  return (
    <ManufacturingGate>
      <AssemblyOrder orderId={orderId} />
    </ManufacturingGate>
  );
}

interface EditDraft {
  locationId: string;
  quantity: string;
  plannedFor: string;
  note: string;
}

const draftOf = (order: AssemblyOrderDetail): EditDraft => ({
  locationId: order.location.id,
  quantity: order.quantity,
  plannedFor: order.plannedFor ?? '',
  note: order.note ?? '',
});

function changes(before: EditDraft, after: EditDraft) {
  const body: {
    locationId?: string;
    quantity?: string;
    plannedFor?: string | null;
    note?: string | null;
  } = {};
  if (after.locationId !== before.locationId) body.locationId = after.locationId;
  if (after.quantity.trim() !== before.quantity) body.quantity = after.quantity.trim();
  if (after.plannedFor !== before.plannedFor)
    body.plannedFor = after.plannedFor === '' ? null : after.plannedFor;
  if (after.note.trim() !== before.note)
    body.note = after.note.trim() === '' ? null : after.note.trim();
  return body;
}

function AssemblyOrder({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const currency = useCurrency();
  const locations = useLocations();
  const [editing, setEditing] = useState<EditDraft | null>(null);

  const detail = useQuery({
    queryKey: keys.assemblyOrder(orderId),
    queryFn: async () =>
      (
        await client.GET('/v1/manufacturing/orders/{orderId}', {
          params: { path: { orderId } },
        })
      ).data!,
  });

  const settle = async (next: AssemblyOrderDetail) => {
    queries.setQueryData(keys.assemblyOrder(orderId), next);
    await queries.invalidateQueries({ queryKey: ['manufacturing', 'orders'] });
    await queries.invalidateQueries({ queryKey: ['inventory'] });
  };
  const update = useMutation({
    mutationFn: async (body: ReturnType<typeof changes> & { useCurrentBill?: boolean }) =>
      (
        await client.PATCH('/v1/manufacturing/orders/{orderId}', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.version, ...body },
        })
      ).data!,
    onSuccess: async (next) => {
      setEditing(null);
      await settle(next);
    },
  });
  const complete = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/manufacturing/orders/{orderId}/complete', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.version },
        })
      ).data!,
    onSuccess: settle,
    // What was short is read against the order as it is now.
    onError: () => void detail.refetch(),
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/manufacturing/orders/{orderId}/cancel', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.version },
        })
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.assemblyOrders} label={t('manufacturing.orders.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <ManufacturingFailure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const order = detail.data;
  const { can } = order;
  const error = [update.error, complete.error, cancel.error].find(
    (candidate) => candidate !== null,
  );
  const reload = () => {
    update.reset();
    complete.reset();
    cancel.reset();
    setEditing(null);
    void detail.refetch();
  };
  const busy = update.isPending || complete.isPending || cancel.isPending;
  const quantityOf = (value: string, unit: Parameters<typeof unitName>[0]) =>
    formatQuantity(value, unit, locale, unitName);
  const money = (value: string) => formatAmount(value, currency, locale);
  const short = order.needs.filter((need) => !isZeroDecimal(need.short));

  // A 409 `shortage` names each short item as `items.<id>`; say how short
  // from the needs as they are now, in this language.
  const shortages =
    error instanceof ApiRequestError && error.code === 'shortage'
      ? error.details.map((detailRow) => {
          const id = detailRow.field.replace(/^items\./u, '');
          const need = order.needs.find((candidate) => candidate.item.id === id);
          return need === undefined || isZeroDecimal(need.short)
            ? detailRow.message
            : t('manufacturing.orders.shortageLine', {
                item: need.item.name,
                quantity: quantityOf(need.short, need.item.unit),
              });
        })
      : [];

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span dir="ltr">{order.reference}</span>
            <AssemblyStatusBadge status={order.status} />
            <DirectionBadge direction={order.direction} />
          </h1>
          <p className="text-sm text-content-muted">
            {t('manufacturing.orders.createdBy', {
              name: order.createdBy.name,
              date: formatDateTime(order.createdAt, { locale }),
            })}
            {order.completedBy === null || order.completedAt === null
              ? null
              : ` · ${t('manufacturing.orders.completedBy', {
                  name: order.completedBy.name,
                  date: formatDateTime(order.completedAt, { locale }),
                })}`}
            {order.cancelledBy === null || order.cancelledAt === null
              ? null
              : ` · ${t('manufacturing.orders.cancelledBy', {
                  name: order.cancelledBy.name,
                  date: formatDateTime(order.cancelledAt, { locale }),
                })}`}
          </p>
          {order.status === 'draft' ? (
            <p className="text-sm text-content-muted">{t('manufacturing.orders.draftHint')}</p>
          ) : null}
        </div>
        {editing === null ? (
          <div className="flex flex-wrap gap-2">
            {can.edit ? (
              <button
                type="button"
                className={buttonClass.primary}
                disabled={!can.complete || busy}
                onClick={() => {
                  if (window.confirm(t('manufacturing.orders.completeConfirm'))) {
                    complete.mutate();
                  }
                }}
              >
                {complete.isPending
                  ? t('manufacturing.orders.completing')
                  : t('manufacturing.orders.complete')}
              </button>
            ) : null}
            {can.edit ? (
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={busy}
                onClick={() => {
                  update.reset();
                  setEditing(draftOf(order));
                }}
              >
                {t('manufacturing.orders.edit')}
              </button>
            ) : null}
            {can.cancel ? (
              <button
                type="button"
                className={buttonClass.danger}
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('manufacturing.orders.cancelConfirm'))) {
                    cancel.mutate();
                  }
                }}
              >
                {t('manufacturing.orders.cancelOrder')}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {error === undefined ? null : (
        <ManufacturingFailure
          error={error}
          onReload={reload}
          extra={
            shortages.length === 0 ? null : (
              <ul className="list-disc ps-5 text-sm text-content">
                {shortages.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )
          }
        />
      )}

      {can.edit && !can.complete && short.length > 0 ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning bg-warning-subtle p-3 text-sm text-content"
        >
          <span>{t('manufacturing.orders.cannotComplete')}</span>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={detail.isFetching}
            onClick={() => void detail.refetch()}
          >
            {t('manufacturing.orders.checkAgain')}
          </button>
        </p>
      ) : null}

      {!order.bom.current && order.status === 'draft' ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning bg-warning-subtle p-3 text-sm text-content"
        >
          <span>
            {t('manufacturing.orders.billSuperseded', {
              version: formatNumber(order.bom.version, { locale }),
            })}
          </span>
          {can.edit ? (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy}
              onClick={() => update.mutate({ useCurrentBill: true })}
            >
              {t('manufacturing.orders.useCurrentBill')}
            </button>
          ) : null}
        </div>
      ) : null}

      {editing !== null ? (
        <form
          aria-label={t('manufacturing.orders.edit')}
          className={cardClass}
          onSubmit={(event) => {
            event.preventDefault();
            const body = changes(draftOf(order), editing);
            if (Object.keys(body).length === 0) {
              setEditing(null);
              return;
            }
            update.mutate(body);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('manufacturing.orders.location')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={editing.locationId}
                  onChange={(event) => setEditing({ ...editing, locationId: event.target.value })}
                >
                  {(locations.data ?? [order.location]).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('manufacturing.orders.quantity')} hint={unitName(order.item.unit)}>
              {(id, describedBy) => (
                <input
                  id={id}
                  required
                  inputMode="decimal"
                  dir="ltr"
                  pattern={QUANTITY_PATTERN}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={editing.quantity}
                  onChange={(event) =>
                    setEditing({ ...editing, quantity: event.target.value.trim() })
                  }
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
                  value={editing.plannedFor}
                  onChange={(event) => setEditing({ ...editing, plannedFor: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('manufacturing.orders.note')}>
              {(id) => (
                <input
                  id={id}
                  maxLength={1000}
                  className={inputClass}
                  value={editing.note}
                  onChange={(event) => setEditing({ ...editing, note: event.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setEditing(null)}
            >
              {t('manufacturing.orders.cancel')}
            </button>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={update.isPending || !isPositiveQuantity(editing.quantity)}
            >
              {update.isPending ? t('manufacturing.orders.saving') : t('manufacturing.orders.save')}
            </button>
          </div>
        </form>
      ) : (
        <section className={cardClass} aria-labelledby="assembly-order-details">
          <h2 id="assembly-order-details" className="text-base font-semibold text-content">
            {t('manufacturing.orders.details')}
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label={t('manufacturing.orders.item')}>
              <AppLink to={paths.item(order.item.id)}>{order.item.name}</AppLink>
              <span dir="ltr" className="ms-2 text-content-muted">
                {order.item.sku}
              </span>
            </Detail>
            <Detail label={t('manufacturing.orders.quantity')}>
              {quantityOf(order.quantity, order.item.unit)}
            </Detail>
            <Detail label={t('manufacturing.orders.location')}>
              <AppLink to={paths.stockLocation(order.location.id)}>{order.location.name}</AppLink>
            </Detail>
            <Detail label={t('manufacturing.orders.plannedFor')}>
              {order.plannedFor === null
                ? t('manufacturing.orders.notPlanned')
                : formatCalendarDate(order.plannedFor, { locale })}
            </Detail>
            <Detail label={t('manufacturing.orders.bill')}>
              <AppLink to={paths.bom(order.item.id)}>
                {t('manufacturing.boms.versionN', {
                  version: formatNumber(order.bom.version, { locale }),
                })}
              </AppLink>
              {order.bom.current ? null : (
                <span className="ms-2 text-content-muted">{t('manufacturing.bom.superseded')}</span>
              )}
            </Detail>
            {order.planId === null ? null : (
              <Detail label={t('manufacturing.orders.plan')}>
                <AppLink to={paths.materialPlan(order.planId)}>
                  {t('manufacturing.orders.fromPlan')}
                </AppLink>
              </Detail>
            )}
            {order.note === null ? null : (
              <Detail label={t('manufacturing.orders.note')} wide>
                <span className="whitespace-pre-wrap">{order.note}</span>
              </Detail>
            )}
          </dl>
        </section>
      )}

      {order.status === 'draft' ? (
        <section className={cardClass} aria-labelledby="assembly-order-needs">
          <h2 id="assembly-order-needs" className="text-base font-semibold text-content">
            {t('manufacturing.orders.needs')}
          </h2>
          <p className="text-sm text-content-muted">
            {t('manufacturing.orders.needsHint', { location: order.location.name })}
          </p>
          {order.needs.length === 0 ? (
            <p className="text-sm text-content-muted">{t('manufacturing.orders.noNeeds')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-content-muted">
                  <tr>
                    <th scope="col" className="py-1 text-start font-medium">
                      {t('manufacturing.orders.item')}
                    </th>
                    <th scope="col" className="py-1 text-end font-medium">
                      {t('manufacturing.orders.needed')}
                    </th>
                    <th scope="col" className="py-1 text-end font-medium">
                      {t('manufacturing.orders.onHand')}
                    </th>
                    <th scope="col" className="py-1 text-end font-medium">
                      {t('manufacturing.orders.reserved')}
                    </th>
                    <th scope="col" className="py-1 text-end font-medium">
                      {t('manufacturing.orders.available')}
                    </th>
                    <th scope="col" className="py-1 text-end font-medium">
                      {t('manufacturing.orders.short')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {order.needs.map((need) => {
                    const isShort = !isZeroDecimal(need.short);
                    return (
                      <tr key={need.item.id} className={isShort ? 'bg-danger-subtle' : ''}>
                        <td className="py-2 ps-1">
                          <AppLink to={paths.item(need.item.id)}>{need.item.name}</AppLink>
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {quantityOf(need.quantity, need.item.unit)}
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {quantityOf(need.onHand, need.item.unit)}
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {quantityOf(need.reserved, need.item.unit)}
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {quantityOf(need.available, need.item.unit)}
                        </td>
                        <td className="py-2 pe-1 text-end tabular-nums">
                          {isShort ? (
                            <span className="font-semibold text-danger">
                              {t('manufacturing.orders.shortBy', {
                                quantity: quantityOf(need.short, need.item.unit),
                              })}
                            </span>
                          ) : (
                            <span className="text-content-muted">
                              {t('manufacturing.orders.enough')}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      <section className={cardClass} aria-labelledby="assembly-order-outputs">
        <h2 id="assembly-order-outputs" className="text-base font-semibold text-content">
          {order.status === 'completed'
            ? t('manufacturing.orders.outputsMade')
            : t('manufacturing.orders.outputs')}
        </h2>
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {order.outputs.map((output) => (
            <li
              key={output.item.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <AppLink to={paths.item(output.item.id)}>{output.item.name}</AppLink>
              <span className="text-content tabular-nums">
                {quantityOf(output.quantity, output.item.unit)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {order.status === 'completed' && order.unitCost !== null ? (
        <section className={cardClass} aria-labelledby="assembly-order-costs">
          <h2 id="assembly-order-costs" className="text-base font-semibold text-content">
            {t('manufacturing.orders.costs')}
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label={t('manufacturing.orders.unitCost')}>{money(order.unitCost)}</Detail>
            <Detail label={t('manufacturing.orders.value')}>
              {money(multiplyDecimal(order.quantity, order.unitCost))}
            </Detail>
            {order.labourCost === null ? null : (
              <Detail label={t('manufacturing.bom.labourCost')}>{money(order.labourCost)}</Detail>
            )}
            {order.overheadCost === null ? null : (
              <Detail label={t('manufacturing.bom.overheadCost')}>
                {money(order.overheadCost)}
              </Detail>
            )}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
