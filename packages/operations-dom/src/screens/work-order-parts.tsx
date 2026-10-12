import { compareDecimals } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type ItemRow, useOperations, type WorkOrderDetail } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import {
  formatQuantity,
  ItemPicker,
  useLocations,
  useUnitName,
} from '../inventory/inventory-parts.js';
import { type LeavingLots, leavingBody, LotList, LotsLeaving } from '../inventory/lots.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BoughtForJob, useJobPurchases } from './job-purchases.js';
import {
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  usePermissions,
  when,
} from '../ui.js';

/**
 * The parts used on a job (CRM/ERP plan, phase E2; ADR-0005): what was taken
 * from which van or store, what it cost (to those who may see costs), and the
 * uses a location could not cover, flagged until the office resolves them.
 * An engineer records from their own van; the office names any location.
 */

type Material = WorkOrderDetail['materials'][number];

const QUANTITY = String.raw`\d{1,16}(\.\d{1,4})?`;
const isPositive = (text: string) => /^\d{1,16}(\.\d{1,4})?$/u.test(text) && /[1-9]/u.test(text);

export function Parts({
  job,
  onChanged,
}: {
  job: WorkOrderDetail;
  onChanged: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const permissions = usePermissions();
  const unitName = useUnitName();
  const [recording, setRecording] = useState(false);
  const [returning, setReturning] = useState<Material | null>(null);
  const [resolving, setResolving] = useState<Material | null>(null);
  const movesStock = permissions.includes('inventory.move');
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
    enabled: job.materialsCost !== null,
  });
  // Parts bought from a merchant for this job (ADR-0012), beside the parts used.
  const purchases = useJobPurchases(
    job.workOrder.id,
    permissions.includes('inventory.read') || permissions.includes('inventory.consume'),
  );
  const bought = purchases.data?.items.length ?? 0;

  if (job.materials.length === 0 && !job.can.recordParts && bought === 0) {
    return null;
  }
  const currency = settings.data?.currency ?? null;
  const money = (value: string) => formatAmount(value, currency, locale);
  const quantity = (material: Material, value: string) =>
    formatQuantity(value, material.item.unit, locale, unitName);

  return (
    <section aria-labelledby="parts-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="parts-heading" className="text-lg font-semibold text-content">
          {t('inventory.parts.title')}
        </h2>
        {job.can.recordParts ? (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setRecording(true)}
          >
            {t('inventory.parts.record')}
          </button>
        ) : null}
      </div>
      {job.materials.length === 0 ? (
        <p className="text-sm text-content-muted">{t('inventory.parts.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {job.materials.map((material) => {
            const open = material.returnedQuantity !== material.quantity;
            return (
              <li key={material.id} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span
                      className={
                        material.status === 'cancelled'
                          ? 'text-content-muted line-through'
                          : 'text-content'
                      }
                    >
                      <a
                        href={paths.item(material.item.id)}
                        className="text-accent underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.item(material.item.id));
                        }}
                      >
                        {material.item.name}
                      </a>
                      <span className="tabular-nums">
                        {' '}
                        · {quantity(material, material.quantity)}
                      </span>
                      {material.location === null ? null : ` · ${material.location.name}`}
                      {material.unitCost === null ? null : (
                        <span className="tabular-nums"> · {money(material.unitCost)}</span>
                      )}
                    </span>
                    {material.lots === null ? null : (
                      <LotList lots={material.lots} unit={material.item.unit} />
                    )}
                    <span className="text-xs text-content-muted">
                      {t('inventory.parts.recordedBy', {
                        name: material.recordedBy.name,
                        when: when(material.occurredAt, locale),
                      })}
                      {material.note === null ? null : ` · ${material.note}`}
                      {material.returnedQuantity === '0'
                        ? null
                        : ` · ${t('inventory.parts.returned', {
                            quantity: quantity(material, material.returnedQuantity),
                          })}`}
                    </span>
                    {material.status === 'conflict' ? (
                      <span role="status" className="text-xs text-danger">
                        {t('inventory.parts.conflictLine', {
                          asked: quantity(material, material.quantity),
                          location: material.location?.name ?? '—',
                          available: quantity(material, material.availableQuantity ?? '0'),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={material.status} />
                    {material.status === 'posted' && open && job.can.recordParts ? (
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        onClick={() => setReturning(material)}
                      >
                        {t('inventory.parts.return')}
                      </button>
                    ) : null}
                    {material.status === 'conflict' && (movesStock || job.can.recordParts) ? (
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        onClick={() => setResolving(material)}
                      >
                        {t('inventory.parts.resolve')}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {job.materialsCost === null ? null : (
        <p className="text-sm text-content">
          <span className="text-content-muted">{t('inventory.parts.cost')}: </span>
          <span className="tabular-nums">{money(job.materialsCost)}</span>
        </p>
      )}

      <BoughtForJob
        workOrderId={job.workOrder.id}
        purchases={purchases.data}
        failed={purchases.isError}
        onRetry={() => void purchases.refetch()}
      />

      {recording ? (
        <RecordDialog
          job={job}
          movesStock={movesStock}
          onClose={() => setRecording(false)}
          onDone={(next) => {
            setRecording(false);
            onChanged(next);
          }}
        />
      ) : null}
      {returning === null ? null : (
        <ReturnDialog
          job={job}
          material={returning}
          onClose={() => setReturning(null)}
          onDone={(next) => {
            setReturning(null);
            onChanged(next);
          }}
        />
      )}
      {resolving === null ? null : (
        <ResolveDialog
          job={job}
          material={resolving}
          movesStock={movesStock}
          onClose={() => setResolving(null)}
          onDone={(next) => {
            setResolving(null);
            onChanged(next);
          }}
        />
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: Material['status'] }) {
  const { t } = useTranslation();
  const style =
    status === 'conflict'
      ? 'border-danger text-danger'
      : status === 'cancelled'
        ? 'border-border-subtle text-content-muted'
        : 'border-border-subtle text-content';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${style}`}>
      {t(`inventory.parts.status.${status}`)}
    </span>
  );
}

function RecordDialog({
  job,
  movesStock,
  onClose,
  onDone,
}: {
  job: WorkOrderDetail;
  movesStock: boolean;
  onClose: () => void;
  onDone: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const unitName = useUnitName();
  const locations = useLocations();
  const [item, setItem] = useState<ItemRow | null>(null);
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  // Which serial numbers or batches (ADR-0013); an expired batch's reason is the note.
  const [lots, setLots] = useState<LeavingLots | undefined>(undefined);
  const tracked = item !== null && item.kind === 'stock_item' && item.tracking !== 'none';
  const from = movesStock ? locationId : (job.van?.id ?? '');
  const body = {
    itemId: item?.id ?? '',
    ...(movesStock && locationId !== '' ? { locationId } : {}),
    quantity,
    ...(note.trim() === '' ? {} : { note: note.trim() }),
    ...(tracked ? leavingBody(lots) : {}),
  };
  const idempotencyKey = useIdempotencyKey(body);
  const ready =
    item !== null &&
    isPositive(quantity) &&
    (movesStock ? locationId !== '' : job.van !== null) &&
    (!tracked || lots?.ready === true);

  const record = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/materials', {
          params: {
            path: { workOrderId: job.workOrder.id },
            header: { 'Idempotency-Key': idempotencyKey },
          },
          body,
        })
      ).data!,
    onSuccess: onDone,
  });

  return (
    <Dialog
      title={t('inventory.parts.record')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('inventory.items.cancel')}
          </button>
          <button
            type="submit"
            form="job-record-part"
            className={buttonClass.primary}
            disabled={!ready || record.isPending}
          >
            {record.isPending ? t('inventory.parts.recording') : t('inventory.parts.record')}
          </button>
        </>
      }
    >
      <form
        id="job-record-part"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            record.mutate();
          }
        }}
      >
        <ItemPicker label={t('inventory.parts.item')} value={item} onChange={setItem} />
        {movesStock ? (
          <Field label={t('inventory.parts.from')}>
            {(id) => (
              <select
                id={id}
                required
                className={inputClass}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{t('inventory.parts.chooseLocation')}</option>
                {(locations.data ?? []).map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : job.van === null ? (
          <p className="text-sm text-danger">{t('inventory.parts.noVan')}</p>
        ) : (
          <p className="text-sm text-content-muted">
            {t('inventory.parts.fromVan', { name: job.van.name })}
          </p>
        )}
        <Field
          label={t('inventory.parts.quantity')}
          {...(item === null ? {} : { hint: unitName(item.unit) })}
        >
          {(id, describedBy) => (
            <input
              id={id}
              required
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY}
              aria-describedby={describedBy}
              className={inputClass}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.trim())}
            />
          )}
        </Field>
        {tracked ? (
          <LotsLeaving
            key={`${item.id}:${from}`}
            itemId={item.id}
            tracking={item.tracking}
            locationId={from}
            quantity={quantity}
            unit={item.unit}
            formReason={note}
            onChange={setLots}
          />
        ) : null}
        <Field label={t('inventory.parts.note')}>
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
        {record.isError ? <Failure error={record.error} /> : null}
      </form>
    </Dialog>
  );
}

function ReturnDialog({
  job,
  material,
  onClose,
  onDone,
}: {
  job: WorkOrderDetail;
  material: Material;
  onClose: () => void;
  onDone: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const unitName = useUnitName();
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  // Which serial numbers come back (ADR-0013); none chosen gives back those used.
  const [back, setBack] = useState<readonly string[]>([]);
  const serials = (material.lots ?? []).filter((lot) => lot.kind === 'serial');
  const chosen = serials.filter((lot) => back.includes(lot.lotId));
  const body = {
    quantity,
    ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
    ...(chosen.length === 0
      ? {}
      : { lots: chosen.map((lot) => ({ lotId: lot.lotId, quantity: '1' })) }),
  };
  const idempotencyKey = useIdempotencyKey(body);
  // Serial numbers come back one unit each: as many chosen as are returned.
  const returnReady =
    isPositive(quantity) &&
    (chosen.length === 0 || compareDecimals(String(chosen.length), quantity) === 0);
  const giveBack = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/materials/{materialId}/return', {
          params: {
            path: { workOrderId: job.workOrder.id, materialId: material.id },
            header: { 'Idempotency-Key': idempotencyKey },
          },
          body,
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('inventory.parts.returnTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('inventory.items.cancel')}
          </button>
          <button
            type="submit"
            form="job-return-part"
            className={buttonClass.primary}
            disabled={!returnReady || giveBack.isPending}
          >
            {giveBack.isPending ? t('inventory.parts.returning') : t('inventory.parts.return')}
          </button>
        </>
      }
    >
      <form
        id="job-return-part"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (returnReady) {
            giveBack.mutate();
          }
        }}
      >
        <p className="text-sm text-content-muted">{t('inventory.parts.returnHint')}</p>
        <Field label={t('inventory.parts.quantity')} hint={unitName(material.item.unit)}>
          {(id, describedBy) => (
            <input
              id={id}
              required
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY}
              aria-describedby={describedBy}
              className={inputClass}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.trim())}
            />
          )}
        </Field>
        {serials.length === 0 ? null : (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium text-content">
              {t('inventory.lots.returnWhich')}
            </legend>
            <p className="text-xs text-content-muted">{t('inventory.lots.returnHint')}</p>
            {serials.map((lot) => (
              <span key={lot.lotId} className="flex items-center gap-2 text-sm">
                <input
                  id={`return-${lot.lotId}`}
                  type="checkbox"
                  checked={back.includes(lot.lotId)}
                  onChange={(event) => {
                    const next = back.filter((lotId) => lotId !== lot.lotId);
                    setBack(event.target.checked ? [...next, lot.lotId] : next);
                    if (event.target.checked || next.length > 0) {
                      setQuantity(String(event.target.checked ? next.length + 1 : next.length));
                    }
                  }}
                />
                <label htmlFor={`return-${lot.lotId}`} dir="ltr">
                  {lot.code}
                </label>
              </span>
            ))}
          </fieldset>
        )}
        <Field label={t('inventory.parts.returnReason')}>
          {(id) => (
            <input
              id={id}
              maxLength={1000}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {giveBack.isError ? <Failure error={giveBack.error} /> : null}
      </form>
    </Dialog>
  );
}

function ResolveDialog({
  job,
  material,
  movesStock,
  onClose,
  onDone,
}: {
  job: WorkOrderDetail;
  material: Material;
  movesStock: boolean;
  onClose: () => void;
  onDone: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const unitName = useUnitName();
  const locations = useLocations();
  const [quantity, setQuantity] = useState(material.quantity);
  const [locationId, setLocationId] = useState(material.location?.id ?? '');
  const [stillShort, setStillShort] = useState(false);
  const [lots, setLots] = useState<LeavingLots | undefined>(undefined);
  const tracked = material.item.tracking !== 'none';
  const retryReady =
    movesStock && isPositive(quantity) && locationId !== '' && (!tracked || lots?.ready === true);
  const retry = {
    action: 'retry' as const,
    quantity,
    locationId,
    ...(tracked ? leavingBody(lots) : {}),
    ...(tracked && lots?.reason !== undefined ? { reason: lots.reason } : {}),
  };
  const resolve = useMutation({
    mutationFn: async (body: { action: 'cancel' } | typeof retry) =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/materials/{materialId}/resolve', {
          params: { path: { workOrderId: job.workOrder.id, materialId: material.id } },
          body,
        })
      ).data!,
    onSuccess: (next, body) => {
      const after = next.materials.find((candidate) => candidate.id === material.id);
      if (body.action === 'retry' && after?.status === 'conflict') {
        setStillShort(true);
        return;
      }
      onDone(next);
    },
  });
  return (
    <Dialog
      title={t('inventory.parts.resolveTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('inventory.items.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ action: 'cancel' })}
          >
            {t('inventory.parts.cancelUse')}
          </button>
          {movesStock ? (
            <button
              type="submit"
              form="job-resolve-part"
              className={buttonClass.primary}
              disabled={!retryReady || resolve.isPending}
            >
              {resolve.isPending ? t('inventory.parts.retrying') : t('inventory.parts.retry')}
            </button>
          ) : null}
        </>
      }
    >
      <form
        id="job-resolve-part"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (retryReady) {
            resolve.mutate(retry);
          }
        }}
      >
        <p className="text-sm text-content-muted">{t('inventory.parts.resolveHint')}</p>
        <p className="text-sm text-content">
          {t('inventory.parts.conflictLine', {
            asked: formatQuantity(material.quantity, material.item.unit, locale, unitName),
            location: material.location?.name ?? '—',
            available: formatQuantity(
              material.availableQuantity ?? '0',
              material.item.unit,
              locale,
              unitName,
            ),
          })}
        </p>
        {movesStock ? (
          <>
            <Field label={t('inventory.parts.quantity')} hint={unitName(material.item.unit)}>
              {(id, describedBy) => (
                <input
                  id={id}
                  required
                  inputMode="decimal"
                  dir="ltr"
                  pattern={QUANTITY}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value.trim())}
                />
              )}
            </Field>
            <Field label={t('inventory.parts.from')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                >
                  <option value="">{t('inventory.parts.chooseLocation')}</option>
                  {(locations.data ?? []).map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {tracked ? (
              <LotsLeaving
                key={locationId}
                {...(locationId === material.location?.id && (material.lots?.length ?? 0) > 0
                  ? {
                      initial: Object.fromEntries(
                        material.lots!.map((lot) => [lot.lotId, lot.quantity]),
                      ),
                    }
                  : {})}
                itemId={material.item.id}
                tracking={material.item.tracking}
                locationId={locationId}
                quantity={quantity}
                unit={material.item.unit}
                onChange={setLots}
              />
            ) : null}
          </>
        ) : null}
        {stillShort ? (
          <p role="status" className="text-sm text-danger">
            {t('inventory.parts.stillShort')}
          </p>
        ) : null}
        {resolve.isError ? <Failure error={resolve.error} /> : null}
      </form>
    </Dialog>
  );
}
