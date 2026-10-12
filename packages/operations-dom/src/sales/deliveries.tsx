import { ApiRequestError } from '@integr8/api-client';
import { compareDecimals, isZeroDecimal } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type DeliveryNote, keys, type SalesOrderDetail, useOperations } from '../api.js';
import { fieldDetail } from '../field-errors.js';
import { formatQuantity, useLocations, useUnitName } from '../inventory/inventory-parts.js';
import {
  isQuantity,
  QUANTITY_PATTERN,
  remainingQuantity,
  useIdempotencyKey,
} from '../purchasing/purchasing-parts.js';
import {
  addressText,
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  InlineError,
  inputClass,
  Loading,
} from '../ui.js';

/**
 * Deliveries by hand on a sales order (eighth round; ADR-0012): whoever
 * manages sales orders hands over some or all of what is left of each line
 * from one of our locations — its reservation there first — never more than
 * was ordered, and prints a delivery note for the customer to sign.
 */

/** What is still to deliver on a line: ordered less delivered. */
const leftOf = (line: SalesOrderDetail['lines'][number]) =>
  remainingQuantity(line.quantity, line.quantityFulfilled);

/** Hands over part or all of an order's lines from one location. */
export function DeliverDialog({
  detail,
  onClose,
  onDone,
  onReload,
}: {
  detail: SalesOrderDetail;
  onClose: () => void;
  onDone: (next: SalesOrderDetail) => Promise<void>;
  /** After a version conflict: read the order again. */
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const locations = useLocations();
  const { order } = detail;
  const ours = (locations.data ?? []).filter(
    (location) => location.ownership !== 'customer' && location.archivedAt === null,
  );
  const open = detail.lines.filter((line) => !isZeroDecimal(leftOf(line)));
  const [locationId, setLocationId] = useState(order.reserveLocation?.id ?? '');
  const [notes, setNotes] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(open.map((line) => [line.id, leftOf(line)])),
  );

  const typed = (lineId: string) => (quantities[lineId] ?? '').trim();
  const tooMuch = (line: SalesOrderDetail['lines'][number]) =>
    isQuantity(typed(line.id)) && compareDecimals(typed(line.id), leftOf(line)) > 0;
  const lines = open.flatMap((line) =>
    isQuantity(typed(line.id)) && !isZeroDecimal(typed(line.id))
      ? [{ orderLineId: line.id, quantity: typed(line.id) }]
      : [],
  );
  const body = {
    expectedVersion: order.version,
    locationId,
    ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
    lines,
  };
  const idempotencyKey = useIdempotencyKey(body);
  const ready =
    locationId !== '' &&
    lines.length > 0 &&
    open.every((line) => typed(line.id) === '' || (isQuantity(typed(line.id)) && !tooMuch(line)));

  const deliver = useMutation({
    mutationFn: async (sent: typeof body) =>
      (
        await client.POST('/v1/sales/orders/{orderId}/deliveries', {
          params: { path: { orderId: order.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: sent,
        })
      ).data!,
    onSuccess: async (result) => {
      await queries.invalidateQueries({ queryKey: keys.deliveries(order.id) });
      await onDone(result.order);
    },
  });

  /** The most the server says is left on a line it refused, by the order line. */
  const refusedLeft = (lineId: string): string | undefined => {
    const index = deliver.variables?.lines.findIndex((line) => line.orderLineId === lineId) ?? -1;
    if (index < 0) {
      return undefined;
    }
    const detail = fieldDetail(deliver.error, `body.lines.${index}.quantity`);
    return detail?.code === 'over_delivery' ? (detail.params?.left ?? '0') : undefined;
  };
  const conflict =
    deliver.error instanceof ApiRequestError && deliver.error.code === 'version_conflict';

  return (
    <Dialog
      title={t('sales.deliveries.deliverTitle', { reference: order.reference })}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('sales.orders.cancel')}
          </button>
          <button
            type="submit"
            form="sales-deliver"
            className={buttonClass.primary}
            disabled={!ready || deliver.isPending}
          >
            {deliver.isPending ? t('sales.deliveries.delivering') : t('sales.deliveries.deliver')}
          </button>
        </>
      }
    >
      <form
        id="sales-deliver"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            deliver.mutate(body);
          }
        }}
      >
        <p className="text-sm text-content">{t('sales.deliveries.intro')}</p>
        <Field label={t('sales.deliveries.location')} hint={t('sales.deliveries.locationHint')}>
          {(id, describedBy) => (
            <select
              id={id}
              required
              aria-describedby={describedBy}
              className={inputClass}
              value={locationId}
              onChange={(event) => {
                deliver.reset();
                setLocationId(event.target.value);
              }}
            >
              <option value="">{t('sales.orders.noLocation')}</option>
              {ours.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {open.length === 0 ? (
          <p className="text-sm text-content-muted">{t('sales.deliveries.nothingLeft')}</p>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium text-content">
              {t('sales.deliveries.lines')}
            </legend>
            {open.map((line) => {
              const left = leftOf(line);
              const server = refusedLeft(line.id);
              const invalid = tooMuch(line) || server !== undefined;
              return (
                <Field
                  key={line.id}
                  label={line.description}
                  hint={
                    invalid
                      ? t('sales.deliveries.atMost', {
                          quantity: formatQuantity(server ?? left, line.unit, locale, unitName),
                        })
                      : t('sales.deliveries.left', {
                          quantity: formatQuantity(left, line.unit, locale, unitName),
                        })
                  }
                >
                  {(id, describedBy) => (
                    <input
                      id={id}
                      inputMode="decimal"
                      dir="ltr"
                      pattern={QUANTITY_PATTERN}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      className={`${inputClass} sm:w-40`}
                      value={quantities[line.id] ?? ''}
                      onChange={(event) => {
                        deliver.reset();
                        setQuantities({ ...quantities, [line.id]: event.target.value.trim() });
                      }}
                    />
                  )}
                </Field>
              );
            })}
          </fieldset>
        )}
        <Field label={t('sales.deliveries.notes')}>
          {(id) => (
            <textarea
              id={id}
              rows={2}
              maxLength={2000}
              className={inputClass}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
        {deliver.isError ? (
          <Failure
            error={deliver.error}
            overrides={{ order_not_open: t('sales.deliveries.orderNotOpen') }}
            actions={
              conflict ? (
                <button type="button" className={buttonClass.secondary} onClick={onReload}>
                  {t('sales.deliveries.reload')}
                </button>
              ) : undefined
            }
          />
        ) : null}
      </form>
    </Dialog>
  );
}

/** The order's deliveries by hand, oldest first, each opening its delivery note. */
export function OrderDeliveries({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const unitName = useUnitName();
  const deliveries = useQuery({
    queryKey: keys.deliveries(orderId),
    queryFn: async () =>
      (
        await client.GET('/v1/sales/orders/{orderId}/deliveries', {
          params: { path: { orderId } },
        })
      ).data!.items,
  });
  return (
    <section aria-labelledby="sales-order-deliveries" className={cardClass}>
      <h2 id="sales-order-deliveries" className="text-base font-semibold text-content">
        {t('sales.deliveries.title')}
      </h2>
      {deliveries.isPending ? (
        <Loading />
      ) : deliveries.isError ? (
        <InlineError onRetry={() => void deliveries.refetch()} />
      ) : deliveries.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('sales.deliveries.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {deliveries.data.map((delivery) => (
            <li key={delivery.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <a
                  href={paths.deliveryNote(orderId, delivery.id)}
                  dir="ltr"
                  className="font-medium text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.deliveryNote(orderId, delivery.id));
                  }}
                >
                  {delivery.reference}
                </a>
                <span className="text-content-muted">
                  {t('sales.deliveries.line', {
                    location: delivery.location.name,
                    name: delivery.deliveredBy.name,
                    date: formatDateTime(delivery.deliveredAt, { locale }),
                  })}
                </span>
              </span>
              <span className="text-xs text-content-muted">
                {delivery.lines
                  .map(
                    (line) =>
                      `${formatQuantity(line.quantity, undefined, locale, unitName)} × ${line.description}`,
                  )
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A delivery note, on screen and printed: the page's own print styles hide the app around it. */
export function DeliveryNoteScreen({
  orderId,
  deliveryId,
}: {
  orderId: string;
  deliveryId: string;
}) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const note = useQuery({
    queryKey: keys.deliveryNote(deliveryId),
    queryFn: async () =>
      (
        await client.GET('/v1/sales/deliveries/{deliveryId}', {
          params: { path: { deliveryId } },
        })
      ).data!,
  });
  const back = (
    <BackLink
      to={paths.salesOrder(note.data?.order.id ?? orderId)}
      label={
        note.data === undefined
          ? t('sales.deliveries.backToOrder')
          : t('nav.backTo', { title: note.data.order.reference })
      }
    />
  );
  if (note.isPending) {
    return <Loading />;
  }
  if (note.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={note.error} onRetry={() => void note.refetch()} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6 text-start print:block">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        {back}
        <button type="button" className={buttonClass.primary} onClick={() => window.print()}>
          {t('sales.deliveries.print')}
        </button>
      </div>
      <DeliveryNoteDocument
        note={note.data}
        locale={locale}
        className="rounded-lg border border-border-subtle print:rounded-none print:border-0"
      />
    </div>
  );
}

/** The note itself: who, what and where — never a price — and a place to sign. */
export function DeliveryNoteDocument({
  note,
  locale,
  className = '',
}: {
  note: DeliveryNote;
  locale: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const unitName = useUnitName();
  const customerAddress = note.customer.address === null ? '' : addressText(note.customer.address);
  const siteAddress = note.site?.address == null ? '' : addressText(note.site.address);
  const quantity = (value: string) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value as unknown as number);

  return (
    <article
      className={`mx-auto flex w-full max-w-3xl flex-col gap-8 bg-white p-8 text-start text-black print:max-w-none print:p-0 ${className}`}
      aria-label={t('sales.deliveries.noteTitle', { reference: note.reference })}
    >
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-0.5 text-sm">
          <p className="text-xl font-semibold">{note.company.name}</p>
          {note.company.address === null ? null : (
            <p className="whitespace-pre-wrap">{note.company.address}</p>
          )}
          {note.company.taxReference === null ? null : (
            <p>{t('sales.deliveries.taxReference', { reference: note.company.taxReference })}</p>
          )}
        </div>
        <div className="flex flex-col items-end text-end">
          <h1 className="text-2xl font-semibold">
            {t('sales.deliveries.noteTitle', { reference: note.reference })}
          </h1>
          <p className="text-sm">
            {t('sales.deliveries.forOrder', { reference: note.order.reference })}
          </p>
          <p className="text-sm">{note.order.title}</p>
          <p className="text-sm">
            {t('sales.deliveries.deliveredOn', {
              date: formatDateTime(note.deliveredAt, { locale }),
            })}
          </p>
        </div>
      </header>

      <div className="grid gap-6 text-sm sm:grid-cols-2 print:grid-cols-2">
        <section className="flex flex-col gap-1">
          <h2 className="text-xs font-medium tracking-wide text-neutral-600 uppercase">
            {t('sales.deliveries.customer')}
          </h2>
          <p className="font-medium">{note.customer.name}</p>
          {customerAddress === '' ? null : <p>{customerAddress}</p>}
        </section>
        <section className="flex flex-col gap-1">
          <h2 className="text-xs font-medium tracking-wide text-neutral-600 uppercase">
            {t('sales.deliveries.site')}
          </h2>
          {note.site === null ? (
            <p>{t('sales.quotes.none')}</p>
          ) : (
            <>
              <p className="font-medium">{note.site.name}</p>
              {siteAddress === '' ? null : <p>{siteAddress}</p>}
            </>
          )}
        </section>
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-black text-xs">
          <tr>
            <th scope="col" className="py-1 text-start font-medium">
              {t('sales.deliveries.sku')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('sales.quotes.description')}
            </th>
            <th scope="col" className="py-1 text-end font-medium">
              {t('sales.quotes.quantity')}
            </th>
            <th scope="col" className="py-1 text-start font-medium ps-3">
              {t('sales.quotes.unit')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-300">
          {note.lines.map((line) => (
            <tr key={line.orderLineId}>
              <td className="py-2" dir="ltr">
                {line.sku ?? '—'}
              </td>
              <td className="py-2">{line.description}</td>
              <td className="py-2 text-end tabular-nums">{quantity(line.quantity)}</td>
              <td className="py-2 ps-3">{unitName(line.unit as Parameters<typeof unitName>[0])}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {note.notes === null ? null : (
        <section className="flex flex-col gap-1 text-sm">
          <h2 className="text-xs font-medium tracking-wide text-neutral-600 uppercase">
            {t('sales.deliveries.notes')}
          </h2>
          <p dir="auto" className="whitespace-pre-wrap">
            {note.notes}
          </p>
        </section>
      )}

      <p className="text-sm">
        {t('sales.deliveries.handedOverBy', {
          name: note.deliveredBy.name,
          location: note.location.name,
        })}
      </p>

      <section
        aria-label={t('sales.deliveries.signature')}
        className="grid gap-8 text-sm sm:grid-cols-3 print:grid-cols-3 print:break-inside-avoid"
      >
        {(['receivedBy', 'signature', 'date'] as const).map((part) => (
          <div key={part} className="flex flex-col gap-1">
            <span aria-hidden="true" className="block h-10 border-b border-black" />
            <span className="text-xs text-neutral-600">{t(`sales.deliveries.${part}`)}</span>
          </div>
        ))}
      </section>

      <footer className="mt-auto text-xs text-neutral-600">{t('sales.deliveries.noPrices')}</footer>
    </article>
  );
}
