import { ApiRequestError } from '@integr8/api-client';
import { compareDecimals, ITEM_TRACKINGS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { type ItemDetail, type ItemTracking, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { buttonClass, Dialog, Failure } from '../ui.js';
import { formatQuantity, useUnitName } from './inventory-parts.js';
import {
  arrivingCheck,
  arrivingLots,
  type ArrivingLots,
  LotCode,
  LotExpiry,
  LotsArriving,
  NO_ARRIVING,
} from './lots.js';

/**
 * Tracking an item by serial number or batch, or stopping (ninth round;
 * ADR-0013). With nothing on hand the change is immediate; with stock, the
 * person names the serial numbers or batches making up each location's
 * stock, a running total against what is there. Stopping keeps the stock.
 */
export function TrackingDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: ItemDetail;
  onClose: () => void;
  onDone: (next: ItemDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const unitName = useUnitName();
  const { item } = detail;
  const [tracking, setTracking] = useState<ItemTracking>(
    item.tracking === 'none' ? 'serial' : 'none',
  );
  const [lots, setLots] = useState<Record<string, ArrivingLots>>({});
  const held = detail.stock.filter((row) => compareDecimals(row.onHand, '0') > 0);
  const naming = tracking !== 'none' && tracking !== item.tracking && held.length > 0;
  const lotsOf = (locationId: string) => lots[locationId] ?? NO_ARRIVING;
  // A serial number is one unit: stock in part units cannot be serialised.
  const partUnits = tracking === 'serial' && held.some((row) => !/^\d+(\.0+)?$/u.test(row.onHand));
  const complete =
    !naming ||
    (!partUnits &&
      held.every((row) => arrivingCheck(tracking, row.onHand, lotsOf(row.location.id)).complete));
  const body = {
    tracking,
    expectedVersion: item.version,
    ...(naming
      ? {
          lots: held.flatMap((row) =>
            arrivingLots(tracking, row.onHand, lotsOf(row.location.id)).map((lot) => ({
              locationId: row.location.id,
              ...lot,
            })),
          ),
        }
      : {}),
  };
  const idempotencyKey = useIdempotencyKey(body);
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/items/{itemId}/tracking', {
          params: { path: { itemId: item.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: onDone,
  });
  const ready = tracking !== item.tracking && complete;

  // A mismatch names the location and both quantities; say it in this language.
  const mismatches =
    save.error instanceof ApiRequestError
      ? save.error.details.flatMap((line) => {
          if (line.code !== 'lots_quantity_mismatch' || line.params === undefined) {
            return [];
          }
          const where = detail.stock.find((row) => row.location.id === line.params?.locationId);
          return [
            t('inventory.lots.switch.mismatch', {
              location: where?.location.name ?? '—',
              quantity: formatQuantity(line.params.quantity ?? '0', item.unit, locale, unitName),
              lots: formatQuantity(line.params.lots ?? '0', item.unit, locale, unitName),
            }),
          ];
        })
      : [];

  return (
    <Dialog
      title={t('inventory.lots.switch.title')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('inventory.items.cancel')}
          </button>
          <button
            type="submit"
            form="inventory-item-tracking"
            className={buttonClass.primary}
            disabled={!ready || save.isPending}
          >
            {save.isPending ? t('inventory.items.saving') : t('inventory.lots.switch.save')}
          </button>
        </>
      }
    >
      <form
        id="inventory-item-tracking"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            save.mutate();
          }
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-content">
            {t('inventory.lots.switch.legend')}
          </legend>
          {ITEM_TRACKINGS.map((choice) => (
            <div key={choice} className="flex items-start gap-2 text-sm text-content">
              <input
                id={`item-tracking-${choice}`}
                type="radio"
                name="item-tracking"
                className="mt-1"
                checked={tracking === choice}
                onChange={() => {
                  save.reset();
                  setTracking(choice);
                }}
                aria-describedby={`item-tracking-${choice}-hint`}
              />
              <span className="flex flex-col">
                <label htmlFor={`item-tracking-${choice}`} className="font-medium">
                  {choice === item.tracking
                    ? t('inventory.lots.switch.current', {
                        tracking: t(`inventory.lots.tracking.${choice}`),
                      })
                    : t(`inventory.lots.tracking.${choice}`)}
                </label>
                <span id={`item-tracking-${choice}-hint`} className="text-xs text-content-muted">
                  {t(`inventory.lots.switch.${choice}Hint`)}
                </span>
              </span>
            </div>
          ))}
        </fieldset>
        {tracking === item.tracking ? null : tracking === 'none' ? (
          <p className="text-sm text-content">{t('inventory.lots.switch.offHint')}</p>
        ) : held.length === 0 ? (
          <p className="text-sm text-content">{t('inventory.lots.switch.noStock')}</p>
        ) : partUnits ? (
          <p role="alert" className="text-sm text-danger">
            {t('inventory.lots.switch.serialWhole')}
          </p>
        ) : (
          <>
            <p className="text-sm text-content">{t('inventory.lots.switch.withStock')}</p>
            {held.map((row) => (
              <LotsArriving
                key={row.location.id}
                tracking={tracking}
                quantity={row.onHand}
                unit={item.unit}
                legend={t('inventory.lots.switch.atLocation', {
                  location: row.location.name,
                  quantity: formatQuantity(row.onHand, item.unit, locale, unitName),
                })}
                value={lotsOf(row.location.id)}
                onChange={(next) => {
                  save.reset();
                  setLots({ ...lots, [row.location.id]: next });
                }}
              />
            ))}
          </>
        )}
        {save.isError ? (
          <Failure error={save.error} {...(mismatches.length > 0 ? { lines: mismatches } : {})} />
        ) : null}
      </form>
    </Dialog>
  );
}

/** The serial numbers or batches a location holds of an item, under its line on the item. */
export function StockLots({
  lots,
  unit,
}: {
  lots: ItemDetail['stock'][number]['lots'];
  unit: ItemDetail['item']['unit'];
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const unitName = useUnitName();
  if (lots.length === 0) {
    return null;
  }
  const serial = lots.every((lot) => lot.kind === 'serial');
  return (
    <div className="flex w-full flex-col gap-1 ps-3 text-xs">
      <span className="text-content-muted">
        {serial ? t('inventory.lots.serialsLabel') : t('inventory.lots.batchesLabel')}
      </span>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {lots.map((lot) => (
          <li key={lot.lotId} className="inline-flex flex-wrap items-center gap-1">
            <LotCode lotId={lot.lotId} code={lot.code} />
            {lot.kind === 'batch' ? (
              <span className="text-content-muted tabular-nums">
                × {formatQuantity(lot.onHand, unit, locale, unitName)}
              </span>
            ) : null}
            <LotExpiry expiresOn={lot.expiresOn} />
          </li>
        ))}
      </ul>
    </div>
  );
}
