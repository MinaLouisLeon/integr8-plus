import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type ReorderDrafted, type ReorderLine, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { formatQuantity, useLocations, useUnitName } from '../inventory/inventory-parts.js';
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
  isPositiveQuantity,
  QUANTITY_PATTERN,
  SupplierPicker,
  useIdempotencyKey,
} from './purchasing-parts.js';

/**
 * A location's reorder list (eighth round; ADR-0012): each item below its
 * reorder level, net of what is already on order, with the quantity that
 * brings it back — raised to the supplier's smallest price break — and the
 * supplier's listed price. The chosen lines become one draft purchase order
 * per supplier, approved as usual.
 */

interface Choice {
  chosen: boolean;
  quantity: string;
  supplierId: string;
}

function choicesOf(lines: readonly ReorderLine[]): Record<string, Choice> {
  return Object.fromEntries(
    lines.map((line) => [
      line.item.id,
      {
        chosen: line.supplier !== null,
        quantity: line.suggested,
        supplierId: line.supplier?.id ?? '',
      },
    ]),
  );
}

export function ReorderScreen({ locationId }: { locationId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const [choices, setChoices] = useState<Record<string, Choice> | null>(null);
  const [drafted, setDrafted] = useState<ReorderDrafted['orders'] | null>(null);

  const location = useQuery({
    queryKey: keys.stockLocation(locationId),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/locations/{locationId}', {
          params: { path: { locationId } },
        })
      ).data!,
  });
  const list = useQuery({
    queryKey: keys.reorder(locationId),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/locations/{locationId}/reorder', {
          params: { path: { locationId } },
        })
      ).data!.items,
  });

  const lines = list.data ?? [];
  const current = choices ?? choicesOf(lines);
  const picked = lines.flatMap((line) => {
    const choice = current[line.item.id];
    return choice?.chosen === true
      ? [{ itemId: line.item.id, supplierId: choice.supplierId, quantity: choice.quantity.trim() }]
      : [];
  });
  const ready =
    picked.length > 0 &&
    picked.every((line) => line.supplierId !== '' && isPositiveQuantity(line.quantity));
  const idempotencyKey = useIdempotencyKey(picked);

  const draft = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/locations/{locationId}/reorder', {
          params: { path: { locationId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { lines: picked },
        })
      ).data!,
    onSuccess: async (result) => {
      setDrafted(result.orders);
      setChoices(null);
      await queries.invalidateQueries({ queryKey: ['purchasing'] });
      await queries.invalidateQueries({ queryKey: keys.reorder(locationId) });
    },
  });

  const update = (itemId: string, patch: Partial<Choice>) => {
    draft.reset();
    setChoices({ ...current, [itemId]: { ...current[itemId]!, ...patch } });
  };
  const name = location.data?.location.name ?? '';
  const back = (
    <BackLink
      to={paths.stockLocation(locationId)}
      label={name === '' ? t('inventory.locations.back') : t('nav.backTo', { title: name })}
    />
  );

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold break-words text-content">
            {name === ''
              ? t('purchasing.reorder.title')
              : t('purchasing.reorder.heading', { location: name })}
          </h1>
          <p className="max-w-prose text-sm text-content-muted">{t('purchasing.reorder.intro')}</p>
        </div>
      </header>

      {drafted === null ? null : (
        <section
          role="status"
          aria-labelledby="purchasing-reorder-drafted"
          className="flex flex-col gap-2 rounded-lg border border-success bg-success-subtle p-4 text-sm text-content"
        >
          <h2 id="purchasing-reorder-drafted" className="font-semibold">
            {t('purchasing.reorder.drafted')}
          </h2>
          <ul className="flex flex-col gap-1">
            {drafted.map((order) => (
              <li key={order.id}>
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
                </a>{' '}
                <span className="text-content-muted">
                  {t('purchasing.reorder.draftedLines', { count: order.lines })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : lines.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('purchasing.reorder.empty')}
        </p>
      ) : (
        <form
          aria-label={t('purchasing.reorder.title')}
          className={cardClass}
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) {
              draft.mutate();
            }
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-content-muted">
                <tr>
                  <th scope="col" className="py-1 pe-2 text-start font-medium">
                    <span className="sr-only">{t('purchasing.reorder.choose')}</span>
                  </th>
                  <th scope="col" className="py-1 text-start font-medium">
                    {t('purchasing.orders.item')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.reorder.minimum')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.reorder.onHand')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.reorder.onOrder')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.reorder.short')}
                  </th>
                  <th scope="col" className="py-1 ps-2 text-start font-medium">
                    {t('purchasing.reorder.quantity')}
                  </th>
                  <th scope="col" className="py-1 ps-2 text-start font-medium">
                    {t('purchasing.orders.supplier')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('purchasing.reorder.listedPrice')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {lines.map((line) => {
                  const choice = current[line.item.id]!;
                  const quantity = (value: string) =>
                    formatQuantity(value, line.item.unit, locale, unitName);
                  const listed =
                    line.price !== null &&
                    line.supplier !== null &&
                    choice.supplierId === line.supplier.id &&
                    choice.quantity.trim() === line.suggested;
                  return (
                    <tr key={line.item.id} className="align-middle">
                      <td className="py-2 pe-2">
                        <input
                          type="checkbox"
                          aria-label={t('purchasing.reorder.chooseNamed', {
                            item: line.item.name,
                          })}
                          checked={choice.chosen}
                          onChange={(event) =>
                            update(line.item.id, { chosen: event.target.checked })
                          }
                        />
                      </td>
                      <td className="py-2">
                        <a
                          href={paths.item(line.item.id)}
                          className="text-accent underline-offset-4 hover:underline"
                          onClick={(event) => {
                            event.preventDefault();
                            navigate(paths.item(line.item.id));
                          }}
                        >
                          {line.item.name}
                        </a>
                        <span dir="ltr" className="ms-2 text-content-muted">
                          {line.item.sku}
                        </span>
                      </td>
                      <td className="py-2 text-end tabular-nums">{quantity(line.minimum)}</td>
                      <td className="py-2 text-end tabular-nums">{quantity(line.onHand)}</td>
                      <td className="py-2 text-end tabular-nums">{quantity(line.onOrder)}</td>
                      <td className="py-2 text-end font-medium tabular-nums">
                        {quantity(line.short)}
                      </td>
                      <td className="py-2 ps-2">
                        <input
                          inputMode="decimal"
                          dir="ltr"
                          pattern={QUANTITY_PATTERN}
                          aria-label={t('purchasing.reorder.quantityNamed', {
                            item: line.item.name,
                          })}
                          aria-invalid={choice.chosen && !isPositiveQuantity(choice.quantity)}
                          className={`${inputClass} w-28`}
                          value={choice.quantity}
                          onChange={(event) =>
                            update(line.item.id, { quantity: event.target.value.trim() })
                          }
                        />
                      </td>
                      <td className="py-2 ps-2">
                        <SupplierPicker
                          id={`reorder-supplier-${line.item.id}`}
                          label={t('purchasing.reorder.supplierNamed', { item: line.item.name })}
                          value={choice.supplierId}
                          noneLabel={t('purchasing.orders.chooseSupplier')}
                          onChange={(supplierId) => update(line.item.id, { supplierId })}
                        />
                      </td>
                      <td className="py-2 text-end tabular-nums">
                        {listed
                          ? formatAmount(line.price!.unitPrice, line.price!.currencyCode, locale)
                          : t('purchasing.reorder.noPrice')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-content-muted">{t('purchasing.reorder.priceHint')}</p>
          {draft.isError ? <Failure error={draft.error} /> : null}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-sm text-content-muted">
              {t('purchasing.reorder.chosen', { count: picked.length })}
            </span>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={!ready || draft.isPending}
            >
              {draft.isPending ? t('purchasing.reorder.drafting') : t('purchasing.reorder.draft')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** From the purchasing area: choose which location to reorder for. */
export function ReorderLocationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { navigate, paths } = useOperations();
  const locations = useLocations();
  const [locationId, setLocationId] = useState('');
  const ours = (locations.data ?? []).filter(
    (location) => location.archivedAt === null && location.ownership === 'ours',
  );
  return (
    <Dialog
      title={t('purchasing.reorder.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('purchasing.orders.cancel')}
          </button>
          <button
            type="submit"
            form="purchasing-reorder-location"
            className={buttonClass.primary}
            disabled={locationId === ''}
          >
            {t('purchasing.reorder.open')}
          </button>
        </>
      }
    >
      <form
        id="purchasing-reorder-location"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (locationId !== '') {
            navigate(paths.reorder(locationId));
          }
        }}
      >
        <p className="text-sm text-content">{t('purchasing.reorder.chooseIntro')}</p>
        {locations.isError ? (
          <Failure error={locations.error} onRetry={() => void locations.refetch()} />
        ) : (
          <Field label={t('purchasing.reorder.location')}>
            {(id) => (
              <select
                id={id}
                required
                className={inputClass}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{t('inventory.move.chooseLocation')}</option>
                {ours.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </form>
    </Dialog>
  );
}
