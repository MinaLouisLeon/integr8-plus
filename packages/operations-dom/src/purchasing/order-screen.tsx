import { formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type GoodsReceipt, keys, type PurchaseOrderDetail, useOperations } from '../api.js';
import { formatAmount, memberName, useMembers } from '../crm/lead-parts.js';
import { formatQuantity, useLocations, useUnitName } from '../inventory/inventory-parts.js';
import {
  arrivingCheck,
  arrivingLots,
  type ArrivingLots,
  type LeavingLots,
  leavingReady,
  LotsArriving,
  LotsLeaving,
  NO_ARRIVING,
} from '../inventory/lots.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
} from '../ui.js';
import {
  type LineDraft,
  lineBodiesOf,
  lineDraftsOf,
  lineDraftValid,
  LinesEditor,
} from './order-list.js';
import { PurchaseOrderDocument } from './order-document.js';
import { BusinessPdfPanel } from '../documents/business-pdfs.js';
import {
  isPositiveQuantity,
  isQuantity,
  OrderStatusBadge,
  percentOfBasisPoints,
  QUANTITY_PATTERN,
  remainingQuantity,
  useIdempotencyKey,
} from './purchasing-parts.js';

/**
 * One purchase order (CRM/ERP plan, phase E2): its lines and totals, who
 * approved or cancelled it, every receipt against it, and — for those who
 * may — editing the draft, approving, cancelling, receiving goods and
 * returning them to the supplier.
 */
export function OrderScreen({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const members = useMembers();
  const [lines, setLines] = useState<LineDraft[] | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [returning, setReturning] = useState<GoodsReceipt | null>(null);

  const detail = useQuery({
    queryKey: keys.purchaseOrder(orderId),
    queryFn: async () =>
      (await client.GET('/v1/purchasing/orders/{orderId}', { params: { path: { orderId } } }))
        .data!,
  });

  const settle = async (next: PurchaseOrderDetail) => {
    queries.setQueryData(keys.purchaseOrder(orderId), next);
    await queries.invalidateQueries({ queryKey: ['purchasing'] });
    await queries.invalidateQueries({ queryKey: ['inventory'] });
  };
  const save = useMutation({
    mutationFn: async (next: LineDraft[]) =>
      (
        await client.PATCH('/v1/purchasing/orders/{orderId}', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.order.version, lines: lineBodiesOf(next) },
        })
      ).data!,
    onSuccess: async (next) => {
      setLines(null);
      await settle(next);
    },
  });
  const approve = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/purchasing/orders/{orderId}/approve', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.order.version },
        })
      ).data!,
    onSuccess: settle,
  });
  const cancel = useMutation({
    mutationFn: async (reason: string) =>
      (
        await client.POST('/v1/purchasing/orders/{orderId}/cancel', {
          params: { path: { orderId } },
          body: {
            expectedVersion: detail.data!.order.version,
            ...(reason === '' ? {} : { reason }),
          },
        })
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.purchaseOrders} label={t('purchasing.orders.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { order, receipts, can } = detail.data;
  const editing = lines !== null;
  const error = [save.error, approve.error, cancel.error].find((candidate) => candidate !== null);
  const money = (value: string) => formatAmount(value, order.currencyCode, locale);

  return (
    <>
      <div aria-hidden="true" className="hidden print:block">
        <PurchaseOrderDocument detail={detail.data} locale={locale} />
      </div>
      <div className="flex flex-col gap-6 text-start print:hidden">
        {back}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
              <span dir="ltr">{order.reference}</span>
              <OrderStatusBadge status={order.status} />
            </h1>
            <p className="text-sm text-content-muted">
              <a
                href={paths.supplier(order.supplier.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.supplier(order.supplier.id));
                }}
              >
                {order.supplier.name}
              </a>
              {' · '}
              {t('purchasing.orders.createdOn', {
                date: formatDateTime(order.createdAt, { locale }),
              })}
              {order.approvedAt === null
                ? null
                : ` · ${t('purchasing.orders.approvedBy', {
                    name: memberName(members.data, order.approvedBy) ?? '—',
                    date: formatDateTime(order.approvedAt, { locale }),
                  })}`}
              {order.cancelledAt === null
                ? null
                : ` · ${t('purchasing.orders.cancelledBy', {
                    name: memberName(members.data, order.cancelledBy) ?? '—',
                    date: formatDateTime(order.cancelledAt, { locale }),
                  })}`}
            </p>
            {order.status === 'draft' ? (
              <p className="text-sm text-content-muted">{t('purchasing.orders.draftHint')}</p>
            ) : null}
          </div>
          {editing ? null : (
            <div className="flex flex-wrap gap-2">
              {can.receive ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => setReceiving(true)}
                >
                  {t('purchasing.orders.receive')}
                </button>
              ) : null}
              {can.approve ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={approve.isPending || detail.data.lines.length === 0}
                  onClick={() => {
                    if (window.confirm(t('purchasing.orders.approveConfirm'))) {
                      approve.mutate();
                    }
                  }}
                >
                  {approve.isPending
                    ? t('purchasing.orders.approving')
                    : t('purchasing.orders.approve')}
                </button>
              ) : null}
              {can.edit ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setLines(lineDraftsOf(detail.data.lines));
                  }}
                >
                  {t('purchasing.orders.edit')}
                </button>
              ) : null}
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => window.print()}
              >
                {t('purchasing.document.print')}
              </button>
              {can.cancel ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={cancel.isPending}
                  onClick={() => {
                    const reason = window.prompt(t('purchasing.orders.cancelReason'), '');
                    if (reason !== null) {
                      cancel.mutate(reason.trim());
                    }
                  }}
                >
                  {t('purchasing.orders.cancelOrder')}
                </button>
              ) : null}
            </div>
          )}
        </header>

        {error === undefined ? null : <Failure error={error} />}

        {order.status === 'draft' ? null : (
          <BusinessPdfPanel kind="purchase_order" recordId={order.id} />
        )}

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('purchasing.orders.expectedDate')}</dt>
            <dd className="text-content">
              {order.expectedDate === null
                ? t('purchasing.orders.noLocation')
                : formatDate(order.expectedDate, { locale })}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('purchasing.orders.deliveryLocation')}</dt>
            <dd className="text-content">
              {order.deliveryLocation === null ? (
                t('purchasing.orders.noLocation')
              ) : (
                <a
                  href={paths.stockLocation(order.deliveryLocation.id)}
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.stockLocation(order.deliveryLocation!.id));
                  }}
                >
                  {order.deliveryLocation.name}
                </a>
              )}
            </dd>
          </div>
          {order.notes === null ? null : (
            <div className="flex flex-col">
              <dt className="text-content-muted">{t('purchasing.orders.notes')}</dt>
              <dd className="break-words whitespace-pre-wrap text-content">{order.notes}</dd>
            </div>
          )}
        </dl>

        <section aria-labelledby="purchasing-order-lines" className={cardClass}>
          <h2 id="purchasing-order-lines" className="text-base font-semibold text-content">
            {t('purchasing.orders.lines')}
          </h2>
          {editing ? (
            <form
              aria-label={t('purchasing.orders.edit')}
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (lines.every(lineDraftValid)) {
                  save.mutate(lines);
                }
              }}
            >
              <LinesEditor lines={lines} onChange={setLines} error={save.error} />
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setLines(null)}
                >
                  {t('purchasing.orders.cancel')}
                </button>
                <button
                  type="submit"
                  className={buttonClass.primary}
                  disabled={!lines.every(lineDraftValid) || save.isPending}
                >
                  {save.isPending ? t('purchasing.orders.saving') : t('purchasing.orders.save')}
                </button>
              </div>
            </form>
          ) : detail.data.lines.length === 0 ? (
            <p className="text-sm text-content-muted">{t('purchasing.orders.noLines')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-content-muted">
                <tr>
                  <th scope="col" className="py-1 text-start font-medium">
                    {t('purchasing.orders.item')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.orders.ordered')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.orders.received')}
                  </th>
                  {order.totals === null ? null : (
                    <>
                      <th scope="col" className="py-1 text-end font-medium">
                        {t('purchasing.orders.unitPrice')}
                      </th>
                      <th scope="col" className="py-1 text-end font-medium">
                        {t('purchasing.orders.taxRate')}
                      </th>
                      <th scope="col" className="py-1 text-end font-medium">
                        {t('purchasing.orders.subtotal')}
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {detail.data.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-2">
                      <a
                        href={paths.item(line.item.id)}
                        className="text-accent underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.item(line.item.id));
                        }}
                      >
                        {line.description}
                      </a>
                      <span dir="ltr" className="ms-2 text-content-muted">
                        {line.item.sku}
                      </span>
                    </td>
                    <td className="py-2 text-end text-content tabular-nums">
                      {formatQuantity(line.quantityOrdered, line.item.unit, locale, unitName)}
                    </td>
                    <td className="py-2 text-end text-content tabular-nums">
                      {formatQuantity(line.quantityReceived, line.item.unit, locale, unitName)}
                    </td>
                    {order.totals === null ? null : (
                      <>
                        <td className="py-2 text-end text-content tabular-nums">
                          {money(line.unitPrice ?? '0')}
                        </td>
                        <td className="py-2 text-end text-content tabular-nums">
                          {percentOfBasisPoints(line.taxRateBp)}%
                        </td>
                        <td className="py-2 text-end text-content tabular-nums">
                          {money(line.subtotal ?? '0')}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {order.totals === null ? null : (
                <tfoot className="text-content">
                  <tr>
                    <th scope="row" colSpan={5} className="pt-3 text-end font-medium">
                      {t('purchasing.orders.subtotal')}
                    </th>
                    <td className="pt-3 text-end tabular-nums">{money(order.totals.subtotal)}</td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={5} className="text-end font-medium">
                      {t('purchasing.orders.tax')}
                    </th>
                    <td className="text-end tabular-nums">{money(order.totals.tax)}</td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={5} className="text-end font-semibold">
                      {t('purchasing.orders.total')}
                    </th>
                    <td className="text-end font-semibold tabular-nums">
                      {money(order.totals.total)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
          {order.totals === null ? (
            <p className="text-xs text-content-muted">{t('purchasing.orders.pricesHidden')}</p>
          ) : null}
        </section>

        <section aria-labelledby="purchasing-order-receipts" className={cardClass}>
          <h2 id="purchasing-order-receipts" className="text-base font-semibold text-content">
            {t('purchasing.orders.receipts')}
          </h2>
          {receipts.length === 0 ? (
            <p className="text-sm text-content-muted">{t('purchasing.orders.noReceipts')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {receipts.map((receipt) => {
                const returnable = receipt.lines.some(
                  (line) => line.returnedQuantity !== line.quantity,
                );
                return (
                  <li key={receipt.id} className="flex flex-col gap-1 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-content">
                        {t('purchasing.orders.receiptOn', {
                          date: formatDateTime(receipt.receivedAt, { locale }),
                          location: receipt.location.name,
                        })}
                        {receipt.supplierNote === null
                          ? null
                          : ` · ${t('purchasing.orders.supplierNote', { note: receipt.supplierNote })}`}
                      </span>
                      {can.cancel && returnable && order.status !== 'cancelled' ? (
                        <button
                          type="button"
                          className={buttonClass.ghost}
                          onClick={() => setReturning(receipt)}
                        >
                          {t('purchasing.orders.return')}
                        </button>
                      ) : null}
                    </div>
                    <ul className="flex flex-col gap-0.5 text-content-muted">
                      {receipt.lines.map((line) => {
                        const ordered = detail.data.lines.find(
                          (candidate) => candidate.id === line.orderLineId,
                        );
                        return (
                          <li key={line.id} className="tabular-nums">
                            {t('purchasing.orders.receiptLine', {
                              quantity: formatQuantity(
                                line.quantity,
                                ordered?.item.unit,
                                locale,
                                unitName,
                              ),
                              description: ordered?.description ?? '—',
                            })}
                            {line.returnedQuantity === '0'
                              ? null
                              : ` · ${t('purchasing.orders.returned', {
                                  quantity: formatQuantity(
                                    line.returnedQuantity,
                                    ordered?.item.unit,
                                    locale,
                                    unitName,
                                  ),
                                })}`}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {receiving ? (
          <ReceiveDialog
            detail={detail.data}
            onClose={() => setReceiving(false)}
            onDone={async (next) => {
              setReceiving(false);
              await settle(next);
            }}
          />
        ) : null}
        {returning === null ? null : (
          <ReturnDialog
            detail={detail.data}
            receipt={returning}
            onClose={() => setReturning(null)}
            onDone={async (next) => {
              setReturning(null);
              await settle(next);
            }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/** Subtracts two decimal strings with up to four places, exactly, never below zero. */
const remaining = remainingQuantity;

function ReceiveDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: PurchaseOrderDetail;
  onClose: () => void;
  onDone: (next: PurchaseOrderDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const unitName = useUnitName();
  const locations = useLocations();
  const { order } = detail;
  const open = detail.lines.filter(
    (line) => remaining(line.quantityOrdered, line.quantityReceived) !== '0',
  );
  const [locationId, setLocationId] = useState(order.deliveryLocation?.id ?? '');
  const [supplierNote, setSupplierNote] = useState('');
  const [notes, setNotes] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});
  // The serial numbers or batches arriving on each tracked line (ADR-0013).
  const [lots, setLots] = useState<Record<string, ArrivingLots>>({});
  const tracked = (line: PurchaseOrderDetail['lines'][number]) =>
    line.item.kind === 'stock_item' && line.item.tracking !== 'none';

  const lines = open.flatMap((line) => {
    const quantity = (quantities[line.id] ?? '').trim();
    if (quantity === '') {
      return [];
    }
    const unitCost = (costs[line.id] ?? '').trim();
    return [
      {
        orderLineId: line.id,
        quantity,
        ...(unitCost === '' ? {} : { unitCost }),
        ...(tracked(line)
          ? { lots: arrivingLots(line.item.tracking, quantity, lots[line.id] ?? NO_ARRIVING) }
          : {}),
      },
    ];
  });
  const valid =
    locationId !== '' &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        isPositiveQuantity(line.quantity) &&
        (line.unitCost === undefined || isQuantity(line.unitCost)),
    ) &&
    open.every(
      (line) =>
        !tracked(line) ||
        (quantities[line.id] ?? '').trim() === '' ||
        arrivingCheck(line.item.tracking, quantities[line.id]!, lots[line.id] ?? NO_ARRIVING)
          .complete,
    );
  const body = {
    expectedVersion: order.version,
    locationId,
    ...(supplierNote.trim() === '' ? {} : { supplierNote: supplierNote.trim() }),
    ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
    lines,
  };
  const idempotencyKey = useIdempotencyKey(body);

  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/purchasing/orders/{orderId}/receipts', {
          params: { path: { orderId: order.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: onDone,
  });

  return (
    <Dialog
      title={t('purchasing.receive.title')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('purchasing.orders.cancel')}
          </button>
          <button
            type="submit"
            form="purchasing-receive"
            className={buttonClass.primary}
            disabled={!valid || post.isPending}
          >
            {post.isPending ? t('purchasing.receive.posting') : t('purchasing.receive.post')}
          </button>
        </>
      }
    >
      <form
        id="purchasing-receive"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            post.mutate();
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('purchasing.receive.location')}>
            {(id) => (
              <select
                id={id}
                required
                className={inputClass}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{t('purchasing.receive.chooseLocation')}</option>
                {(locations.data ?? []).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('purchasing.receive.supplierNote')}>
            {(id) => (
              <input
                id={id}
                maxLength={200}
                dir="ltr"
                className={inputClass}
                value={supplierNote}
                onChange={(event) => setSupplierNote(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('purchasing.receive.notes')} className="sm:col-span-2">
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
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {open.map((line) => (
            <li key={line.id} className="grid gap-3 py-3 sm:grid-cols-3">
              <div className="flex flex-col">
                <span className="text-content">{line.description}</span>
                <span className="text-xs text-content-muted tabular-nums">
                  {t('purchasing.receive.remaining', {
                    quantity: formatQuantity(
                      remaining(line.quantityOrdered, line.quantityReceived),
                      line.item.unit,
                      locale,
                      unitName,
                    ),
                  })}
                </span>
              </div>
              <Field label={`${t('purchasing.receive.quantity')} · ${line.description}`}>
                {(id) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    dir="ltr"
                    pattern={QUANTITY_PATTERN}
                    className={inputClass}
                    value={quantities[line.id] ?? ''}
                    onChange={(event) =>
                      setQuantities({ ...quantities, [line.id]: event.target.value.trim() })
                    }
                  />
                )}
              </Field>
              {order.totals === null ? null : (
                <Field
                  label={`${t('purchasing.receive.unitCost')} · ${line.description}`}
                  hint={t('purchasing.receive.unitCostHint')}
                >
                  {(id, describedBy) => (
                    <input
                      id={id}
                      inputMode="decimal"
                      dir="ltr"
                      pattern={QUANTITY_PATTERN}
                      aria-describedby={describedBy}
                      className={inputClass}
                      placeholder={line.unitPrice ?? ''}
                      value={costs[line.id] ?? ''}
                      onChange={(event) =>
                        setCosts({ ...costs, [line.id]: event.target.value.trim() })
                      }
                    />
                  )}
                </Field>
              )}
              {tracked(line) && isPositiveQuantity(quantities[line.id] ?? '') ? (
                <div className="sm:col-span-3">
                  <LotsArriving
                    tracking={line.item.tracking}
                    quantity={quantities[line.id]!}
                    unit={line.item.unit}
                    legend={t('inventory.lots.lotsOf', { item: line.description })}
                    value={lots[line.id] ?? NO_ARRIVING}
                    onChange={(next) => {
                      post.reset();
                      setLots({ ...lots, [line.id]: next });
                    }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {lines.length === 0 ? (
          <p className="text-xs text-content-muted">{t('purchasing.receive.nothing')}</p>
        ) : null}
        {post.isError ? <Failure error={post.error} /> : null}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/** The lots a return names, when the person chose any; a return needs no confirmation for an expired batch. */
function namedLots(result: LeavingLots | undefined): {
  lots?: { lotId: string; quantity: string }[];
} {
  return result?.lots === undefined || result.lots.length === 0 ? {} : { lots: result.lots };
}

function ReturnDialog({
  detail,
  receipt,
  onClose,
  onDone,
}: {
  detail: PurchaseOrderDetail;
  receipt: GoodsReceipt;
  onClose: () => void;
  onDone: (next: PurchaseOrderDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const unitName = useUnitName();
  const [reason, setReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  // Which serial numbers or batches go back (ADR-0013); none chosen sends
  // back those the receipt brought in that are still there.
  const [lots, setLots] = useState<Record<string, LeavingLots | undefined>>({});
  const open = receipt.lines.filter((line) => line.returnedQuantity !== line.quantity);
  const orderedOf = (line: GoodsReceipt['lines'][number]) =>
    detail.lines.find((candidate) => candidate.id === line.orderLineId);
  const picking = (line: GoodsReceipt['lines'][number]) => {
    const item = orderedOf(line)?.item;
    return (
      item?.kind === 'stock_item' &&
      item.tracking !== 'none' &&
      isPositiveQuantity(quantities[line.id] ?? '')
    );
  };

  const lines = open.flatMap((line) => {
    const quantity = (quantities[line.id] ?? '').trim();
    return quantity === ''
      ? []
      : [
          {
            receiptLineId: line.id,
            quantity,
            ...(picking(line) ? namedLots(lots[line.id]) : {}),
          },
        ];
  });
  const valid =
    reason.trim() !== '' &&
    lines.length > 0 &&
    lines.every((line) => isPositiveQuantity(line.quantity)) &&
    leavingReady(
      lots,
      open.filter(picking).map((line) => line.id),
    );
  const body = { reason: reason.trim(), lines };
  const idempotencyKey = useIdempotencyKey(body);

  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/purchasing/receipts/{receiptId}/returns', {
          params: {
            path: { receiptId: receipt.id },
            header: { 'Idempotency-Key': idempotencyKey },
          },
          body,
        })
      ).data!,
    onSuccess: onDone,
  });

  return (
    <Dialog
      title={t('purchasing.returns.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('purchasing.orders.cancel')}
          </button>
          <button
            type="submit"
            form="purchasing-return"
            className={buttonClass.primary}
            disabled={!valid || post.isPending}
          >
            {post.isPending ? t('purchasing.returns.posting') : t('purchasing.returns.post')}
          </button>
        </>
      }
    >
      <form
        id="purchasing-return"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            post.mutate();
          }
        }}
      >
        <p className="text-sm text-content-muted">{t('purchasing.returns.intro')}</p>
        <Field label={t('purchasing.returns.reason')}>
          {(id) => (
            <input
              id={id}
              required
              maxLength={1000}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {open.map((line) => {
          const ordered = orderedOf(line);
          return (
            <div key={line.id} className="flex flex-col gap-2">
              <Field
                label={`${t('purchasing.returns.quantity')} · ${ordered?.description ?? '—'}`}
                hint={t('purchasing.returns.ofReceived', {
                  quantity: formatQuantity(
                    remaining(line.quantity, line.returnedQuantity),
                    ordered?.item.unit,
                    locale,
                    unitName,
                  ),
                })}
              >
                {(id, describedBy) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    dir="ltr"
                    pattern={QUANTITY_PATTERN}
                    aria-describedby={describedBy}
                    className={inputClass}
                    value={quantities[line.id] ?? ''}
                    onChange={(event) =>
                      setQuantities({ ...quantities, [line.id]: event.target.value.trim() })
                    }
                  />
                )}
              </Field>
              {ordered !== undefined && picking(line) ? (
                <LotsLeaving
                  itemId={ordered.item.id}
                  tracking={ordered.item.tracking}
                  locationId={receipt.location.id}
                  quantity={quantities[line.id]!}
                  unit={ordered.item.unit}
                  expired="allowed"
                  optional
                  legend={t('inventory.lots.lotsOf', { item: ordered.description })}
                  hint={t('inventory.lots.returnToSupplierHint')}
                  onChange={(next) => setLots((current) => ({ ...current, [line.id]: next }))}
                />
              ) : null}
            </div>
          );
        })}
        {post.isError ? <Failure error={post.error} /> : null}
      </form>
    </Dialog>
  );
}
