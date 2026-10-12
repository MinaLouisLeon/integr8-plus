import { compareDecimals } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations, type VanRequest, type VanRequestStatus } from '../api.js';
import { fieldDetail } from '../field-errors.js';
import {
  isPositiveQuantity,
  isQuantity,
  QUANTITY_PATTERN,
} from '../purchasing/purchasing-parts.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  usePermissions,
} from '../ui.js';
import { formatQuantity, useLocations, useUnitName } from './inventory-parts.js';
import { type LeavingLots, leavingReady, LotsLeaving } from './lots.js';

/**
 * The store's queue of van refills (eighth round; ADR-0012): what engineers
 * asked for their vans, open requests oldest first. Those who move stock
 * pick a request at one of our warehouses — possibly short, never more than
 * asked — which transfers the goods to the van, or withdraw it. Online only.
 */

const STATUSES = ['open', 'picked', 'cancelled'] as const;
type Filter = VanRequestStatus | 'all';

const STATUS_STYLE: Record<VanRequestStatus, string> = {
  open: 'border-warning bg-warning-subtle text-content',
  picked: 'border-success bg-success-subtle text-content',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

function RequestStatusBadge({ status }: { status: VanRequestStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {t(`inventory.vanRequests.status.${status}`)}
    </span>
  );
}

export function VanRequestsScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const permissions = usePermissions();
  const [filter, setFilter] = useState<Filter>('open');
  const [picking, setPicking] = useState<VanRequest | null>(null);

  const query = filter === 'all' ? { limit: 100 } : { status: [filter], limit: 100 };
  const requests = useQuery({
    queryKey: keys.vanRequests(query),
    queryFn: async () =>
      (await client.GET('/v1/inventory/van-requests', { params: { query } })).data!.items,
  });
  const cancel = useMutation({
    mutationFn: async (request: VanRequest) =>
      (
        await client.POST('/v1/inventory/van-requests/{requestId}/cancel', {
          params: { path: { requestId: request.id } },
          body: { expectedVersion: request.version },
        })
      ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['inventory', 'van-requests'] });
    },
  });

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">
            {t('inventory.vanRequests.title')}
          </h1>
          <p className="max-w-prose text-sm text-content-muted">
            {t('inventory.vanRequests.intro')}
          </p>
        </div>
        <Field label={t('inventory.vanRequests.filter')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filter}
              onChange={(event) => setFilter(event.target.value as Filter)}
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`inventory.vanRequests.status.${status}`)}
                </option>
              ))}
              <option value="all">{t('inventory.vanRequests.all')}</option>
            </select>
          )}
        </Field>
      </header>

      {cancel.isError ? <Failure error={cancel.error} /> : null}

      {requests.isPending ? (
        <Loading />
      ) : requests.isError ? (
        <Failure error={requests.error} onRetry={() => void requests.refetch()} />
      ) : requests.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filter === 'open'
            ? t('inventory.vanRequests.emptyOpen')
            : t('inventory.vanRequests.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.data.map((request) => (
            <li key={request.id}>
              <article
                aria-label={t('inventory.vanRequests.requestFor', { van: request.van.name })}
                className={cardClass}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-content">
                      <a
                        href={paths.stockLocation(request.van.id)}
                        className="text-accent underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.stockLocation(request.van.id));
                        }}
                      >
                        {request.van.name}
                      </a>
                      <RequestStatusBadge status={request.status} />
                    </h2>
                    <p className="text-sm text-content-muted">
                      {t('inventory.vanRequests.askedBy', {
                        name: request.requestedBy.name,
                        date: formatDateTime(request.requestedAt, { locale }),
                      })}
                    </p>
                    {request.status === 'picked' && request.pickedAt !== null ? (
                      <p className="text-sm text-content-muted">
                        {t('inventory.vanRequests.pickedLine', {
                          location: request.from?.name ?? '—',
                          name: request.pickedBy?.name ?? '—',
                          date: formatDateTime(request.pickedAt, { locale }),
                        })}
                      </p>
                    ) : null}
                    {request.status === 'cancelled' && request.cancelledAt !== null ? (
                      <p className="text-sm text-content-muted">
                        {t('inventory.vanRequests.cancelledLine', {
                          date: formatDateTime(request.cancelledAt, { locale }),
                        })}
                      </p>
                    ) : null}
                    {request.notes === null ? null : (
                      <p dir="auto" className="text-sm whitespace-pre-wrap text-content">
                        {request.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {request.can.pick && permissions.includes('inventory.move') ? (
                      <button
                        type="button"
                        className={buttonClass.primary}
                        onClick={() => setPicking(request)}
                      >
                        {t('inventory.vanRequests.pick')}
                      </button>
                    ) : null}
                    {request.can.cancel ? (
                      <button
                        type="button"
                        className={buttonClass.secondary}
                        disabled={cancel.isPending}
                        onClick={() => {
                          if (window.confirm(t('inventory.vanRequests.cancelConfirm'))) {
                            cancel.mutate(request);
                          }
                        }}
                      >
                        {t('inventory.vanRequests.cancel')}
                      </button>
                    ) : null}
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-content-muted">
                    <tr>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('inventory.vanRequests.item')}
                      </th>
                      <th scope="col" className="py-1 text-end font-medium">
                        {t('inventory.vanRequests.requested')}
                      </th>
                      {request.status === 'picked' ? (
                        <th scope="col" className="py-1 text-end font-medium">
                          {t('inventory.vanRequests.picked')}
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {request.lines.map((line) => (
                      <tr key={line.item.id}>
                        <td className="py-1.5">
                          {line.item.name}
                          <span dir="ltr" className="ms-2 text-content-muted">
                            {line.item.sku}
                          </span>
                        </td>
                        <td className="py-1.5 text-end tabular-nums">
                          {formatQuantity(line.requested, line.item.unit, locale, unitName)}
                        </td>
                        {request.status === 'picked' ? (
                          <td className="py-1.5 text-end tabular-nums">
                            {formatQuantity(line.picked ?? '0', line.item.unit, locale, unitName)}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            </li>
          ))}
        </ul>
      )}

      {picking === null ? null : (
        <PickDialog
          request={picking}
          onClose={() => setPicking(null)}
          onDone={async () => {
            setPicking(null);
            await queries.invalidateQueries({ queryKey: ['inventory'] });
          }}
        />
      )}
    </div>
  );
}

/** Picks a request at one of our warehouses: per line, what is sent — 0 up to what was asked. */
function PickDialog({
  request,
  onClose,
  onDone,
}: {
  request: VanRequest;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const unitName = useUnitName();
  const locations = useLocations();
  const warehouses = (locations.data ?? []).filter(
    (location) =>
      location.kind === 'warehouse' &&
      location.ownership === 'ours' &&
      location.archivedAt === null,
  );
  const [chosen, setChosen] = useState('');
  const fromLocationId = chosen === '' && warehouses.length === 1 ? warehouses[0]!.id : chosen;
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.lines.map((line) => [line.item.id, line.requested])),
  );
  const over = (itemId: string, requested: string) => {
    const typed = quantities[itemId] ?? '';
    return isQuantity(typed) && compareDecimals(typed.trim(), requested) > 0;
  };
  // Serial numbers and batches go to the van as chosen (ADR-0013); an expired
  // batch is never sent.
  const [lots, setLots] = useState<Record<string, LeavingLots | undefined>>({});
  const picking = (line: VanRequest['lines'][number]) =>
    line.item.tracking !== 'none' && isPositiveQuantity(quantities[line.item.id] ?? '');
  const ready =
    fromLocationId !== '' &&
    request.lines.every(
      (line) => isQuantity(quantities[line.item.id] ?? '') && !over(line.item.id, line.requested),
    ) &&
    leavingReady(
      lots,
      request.lines.filter(picking).map((line) => line.item.id),
    );

  const pick = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/van-requests/{requestId}/pick', {
          params: { path: { requestId: request.id } },
          body: {
            expectedVersion: request.version,
            fromLocationId,
            lines: request.lines.map((line) => {
              const named = lots[line.item.id]?.lots ?? [];
              return {
                itemId: line.item.id,
                quantity: (quantities[line.item.id] ?? '0').trim(),
                ...(picking(line) && named.length > 0 ? { lots: named } : {}),
              };
            }),
          },
        })
      ).data!,
    onSuccess: onDone,
  });

  return (
    <Dialog
      title={t('inventory.vanRequests.pickTitle', { van: request.van.name })}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('inventory.items.cancel')}
          </button>
          <button
            type="submit"
            form="inventory-van-pick"
            className={buttonClass.primary}
            disabled={!ready || pick.isPending}
          >
            {pick.isPending ? t('inventory.vanRequests.sending') : t('inventory.vanRequests.send')}
          </button>
        </>
      }
    >
      <form
        id="inventory-van-pick"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            pick.mutate();
          }
        }}
      >
        <p className="text-sm text-content">{t('inventory.vanRequests.pickIntro')}</p>
        <Field label={t('inventory.vanRequests.from')}>
          {(id) => (
            <select
              id={id}
              required
              className={inputClass}
              value={fromLocationId}
              onChange={(event) => {
                pick.reset();
                setChosen(event.target.value);
              }}
            >
              <option value="">{t('inventory.vanRequests.chooseWarehouse')}</option>
              {warehouses.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <ul className="flex flex-col gap-3">
          {request.lines.map((line, index) => {
            const refused = fieldDetail(pick.error, `body.lines.${index}.quantity`);
            const limit =
              refused?.code === 'over_request'
                ? (refused.params?.requested ?? line.requested)
                : null;
            const tooMany = over(line.item.id, line.requested) || limit !== null;
            return (
              <li key={line.item.id}>
                <Field
                  label={line.item.name}
                  hint={
                    tooMany
                      ? t('inventory.vanRequests.atMost', {
                          quantity: formatQuantity(
                            limit ?? line.requested,
                            line.item.unit,
                            locale,
                            unitName,
                          ),
                        })
                      : t('inventory.vanRequests.askedFor', {
                          quantity: formatQuantity(
                            line.requested,
                            line.item.unit,
                            locale,
                            unitName,
                          ),
                        })
                  }
                >
                  {(id, describedBy) => (
                    <input
                      id={id}
                      required
                      inputMode="decimal"
                      dir="ltr"
                      pattern={QUANTITY_PATTERN}
                      aria-describedby={describedBy}
                      aria-invalid={tooMany}
                      className={`${inputClass} sm:w-40`}
                      value={quantities[line.item.id] ?? ''}
                      onChange={(event) => {
                        pick.reset();
                        setQuantities({ ...quantities, [line.item.id]: event.target.value.trim() });
                      }}
                    />
                  )}
                </Field>
                {picking(line) ? (
                  <div className="mt-2">
                    <LotsLeaving
                      key={fromLocationId}
                      itemId={line.item.id}
                      tracking={line.item.tracking}
                      locationId={fromLocationId}
                      quantity={quantities[line.item.id]!}
                      unit={line.item.unit}
                      expired="never"
                      legend={t('inventory.lots.lotsOf', { item: line.item.name })}
                      onChange={(next) =>
                        setLots((current) => ({ ...current, [line.item.id]: next }))
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {pick.isError ? <Failure error={pick.error} /> : null}
      </form>
    </Dialog>
  );
}
