import { compareDecimals, isZeroDecimal } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { type ItemLot, type ItemTracking, keys, type Unit, useOperations } from '../api.js';
import {
  isPositiveQuantity,
  isQuantity,
  QUANTITY_PATTERN,
} from '../purchasing/purchasing-parts.js';
import { buttonClass, Field, InlineError, inputClass } from '../ui.js';
import { formatQuantity, useUnitName } from './inventory-parts.js';

/**
 * Serial numbers and batches on the screens that move stock (ninth round;
 * ADR-0013). Stock arriving names its codes — a serial number per unit, a
 * batch with its expiry; stock leaving is chosen from what the location
 * holds, the earliest expiry proposed and the person free to change it. An
 * expired batch is used only when the person confirms it and says why.
 *
 * Quantities stay decimal strings throughout, added as whole numbers of
 * ten-thousandths and never as JavaScript numbers.
 */

/** A decimal string of up to four places as ten-thousandths. */
function units(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.');
  return BigInt(`${whole === '' ? '0' : whole}${fraction.padEnd(4, '0').slice(0, 4)}`);
}

function decimal(value: bigint): string {
  const digits = value.toString().padStart(5, '0');
  const fraction = digits.slice(-4).replace(/0+$/u, '');
  return `${digits.slice(0, -4)}${fraction === '' ? '' : `.${fraction}`}`;
}

/** The sum of decimal quantities, exactly: `0.1` and `0.2` make `0.3`. Invalid ones count as none. */
export function addQuantities(values: readonly string[]): string {
  return decimal(values.reduce((sum, value) => (isQuantity(value) ? sum + units(value) : sum), 0n));
}

/** A quantity as a whole number of units, when it is one and no more than `limit`. */
function wholeUnits(quantity: string, limit = 500): number {
  if (!isQuantity(quantity) || !isZeroDecimal(quantity.split('.')[1] ?? '0')) {
    return 0;
  }
  const count = units(quantity) / 10_000n;
  return count > BigInt(limit) ? 0 : Number(count);
}

/** Today in this device's calendar, as `YYYY-MM-DD`: the day expiry is read against. */
export function todayInput(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** Whether a batch is past its expiry day (`YYYY-MM-DD`), today in this device's calendar. */
export function isExpired(expiresOn: string | null | undefined, today = todayInput()): boolean {
  return expiresOn !== null && expiresOn !== undefined && expiresOn < today;
}

/**
 * Serial numbers pasted or scanned in one go: one per line — or separated by
 * commas, semicolons or tabs, as a spreadsheet column pastes — trimmed, each
 * once, in the order given.
 */
export function splitSerials(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\r\n,;\t]+/u)
    .map((code) => code.trim())
    .filter((code) => {
      if (code === '' || seen.has(code)) {
        return false;
      }
      seen.add(code);
      return true;
    });
}

// ---------------------------------------------------------------------------
// Showing lots
// ---------------------------------------------------------------------------

/** "Expired" in words beside the date, never colour alone. */
export function ExpiredBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-danger bg-danger-subtle px-2 py-0.5 text-xs font-medium text-danger">
      {t('inventory.lots.expired')}
    </span>
  );
}

/** A batch's expiry: the date, and the badge once it has passed. */
export function LotExpiry({ expiresOn }: { expiresOn: string | null }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  if (expiresOn === null) {
    return null;
  }
  const date = formatCalendarDate(expiresOn, { locale });
  return isExpired(expiresOn) ? (
    <span className="inline-flex flex-wrap items-center gap-1">
      <ExpiredBadge />
      <span className="text-xs text-content-muted">{t('inventory.lots.expiredOn', { date })}</span>
    </span>
  ) : (
    <span className="text-xs text-content-muted">{t('inventory.lots.expires', { date })}</span>
  );
}

/** A serial number or batch code, opening its trace when it has one. */
export function LotCode({ lotId, code }: { lotId?: string | null | undefined; code: string }) {
  const { paths, navigate } = useOperations();
  if (lotId === undefined || lotId === null) {
    return (
      <span dir="ltr" className="font-medium text-content">
        {code}
      </span>
    );
  }
  return (
    <a
      href={paths.lot(lotId)}
      dir="ltr"
      className="font-medium text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(paths.lot(lotId));
      }}
    >
      {code}
    </a>
  );
}

export interface ShownLot {
  lotId?: string | null;
  kind: 'serial' | 'batch';
  code: string;
  expiresOn?: string | null;
  quantity: string;
}

/**
 * The serial numbers or batches a part, a delivery line or a movement moved:
 * "Serial numbers: A, B" or "Batches: X × 3". Codes link to their trace when
 * `links` and the lot's id are given.
 */
export function LotList({
  lots,
  unit,
  links = true,
  className = '',
}: {
  lots: readonly ShownLot[];
  unit?: Unit | undefined;
  links?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const unitName = useUnitName();
  if (lots.length === 0) {
    return null;
  }
  const serial = lots.every((lot) => lot.kind === 'serial');
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs ${className}`}>
      <span className="text-content-muted">
        {serial ? t('inventory.lots.serialsLabel') : t('inventory.lots.batchesLabel')}
      </span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {lots.map((lot) => (
          <li key={`${lot.lotId ?? ''}:${lot.code}`} className="inline-flex flex-wrap gap-1">
            <LotCode lotId={links ? lot.lotId : undefined} code={lot.code} />
            {lot.kind === 'batch' ? (
              <span className="text-content-muted tabular-nums">
                × {formatQuantity(lot.quantity, unit, locale, unitName)}
              </span>
            ) : null}
            {lot.expiresOn === undefined ? null : <LotExpiry expiresOn={lot.expiresOn} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How an item's units are told apart, in words. */
export function TrackingBadge({ tracking }: { tracking: ItemTracking }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        tracking === 'none'
          ? 'border-border-subtle text-content-muted'
          : 'border-accent bg-surface text-content'
      }`}
    >
      {t(`inventory.lots.tracking.${tracking}`)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stock arriving: the codes
// ---------------------------------------------------------------------------

export interface ArrivingBatch {
  code: string;
  expiresOn: string;
  /** Empty on the only row: all of what arrives. */
  quantity: string;
}

/** The codes typed for stock arriving: serial numbers one per unit, or batches. */
export interface ArrivingLots {
  serials: string[];
  batches: ArrivingBatch[];
}

export const NO_ARRIVING: ArrivingLots = {
  serials: [],
  batches: [{ code: '', expiresOn: '', quantity: '' }],
};

/** One input per unit arriving, and any serial typed beyond that kept. */
function serialSlots(serials: readonly string[], quantity: string): string[] {
  const filled = serials.reduce((last, code, index) => (code.trim() === '' ? last : index + 1), 0);
  const count = Math.max(wholeUnits(quantity), filled, 1);
  return Array.from({ length: count }, (_, index) => serials[index] ?? '');
}

/** What stock arriving names, as the API takes it; empty rows are left out. */
export function arrivingLots(
  tracking: ItemTracking,
  quantity: string,
  value: ArrivingLots,
): { code: string; expiresOn?: string; quantity: string }[] {
  if (tracking === 'serial') {
    return value.serials
      .map((code) => code.trim())
      .filter((code) => code !== '')
      .map((code) => ({ code, quantity: '1' }));
  }
  if (tracking === 'batch') {
    const single = value.batches.length === 1;
    return value.batches
      .filter((row) => row.code.trim() !== '')
      .map((row) => ({
        code: row.code.trim(),
        ...(row.expiresOn === '' ? {} : { expiresOn: row.expiresOn }),
        quantity: single && row.quantity.trim() === '' ? quantity.trim() : row.quantity.trim(),
      }));
  }
  return [];
}

/**
 * Whether the codes make up what arrives: every one valid and named once,
 * adding up exactly to the quantity. `total` is what they add up to so far.
 */
export function arrivingCheck(
  tracking: ItemTracking,
  quantity: string,
  value: ArrivingLots,
): { total: string; complete: boolean; repeated: ReadonlySet<string> } {
  const lots = arrivingLots(tracking, quantity, value);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const lot of lots) {
    const code = lot.code.toLowerCase();
    if (seen.has(code)) {
      repeated.add(code);
    }
    seen.add(code);
  }
  const total = addQuantities(lots.map((lot) => lot.quantity));
  const complete =
    tracking === 'none' ||
    (lots.length > 0 &&
      repeated.size === 0 &&
      lots.every((lot) => isPositiveQuantity(lot.quantity)) &&
      isPositiveQuantity(quantity) &&
      compareDecimals(total, quantity.trim()) === 0);
  return { total, complete, repeated };
}

/** The running total against what arrives or is held, said as it changes. */
function RunningTotal({
  total,
  quantity,
  complete,
  unit,
}: {
  total: string;
  quantity: string;
  complete: boolean;
  unit?: Unit | undefined;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const unitName = useUnitName();
  return (
    <p
      role="status"
      className={`text-xs tabular-nums ${complete ? 'text-content-muted' : 'text-danger'}`}
    >
      {t('inventory.lots.total', {
        total: formatQuantity(total, unit, locale, unitName),
        quantity: formatQuantity(
          isQuantity(quantity) ? quantity.trim() : '0',
          unit,
          locale,
          unitName,
        ),
      })}{' '}
      {complete ? t('inventory.lots.addsUp') : t('inventory.lots.doesNotAddUp')}
    </p>
  );
}

/**
 * The codes of stock arriving. A serial-numbered item gets one row per unit
 * and a box to paste or scan many at once, each line filling the next empty
 * row; a batched item one row per batch, with its expiry.
 */
export function LotsArriving({
  tracking,
  quantity,
  unit,
  value,
  onChange,
  legend,
}: {
  tracking: ItemTracking;
  quantity: string;
  unit?: Unit | undefined;
  value: ArrivingLots;
  onChange: (next: ArrivingLots) => void;
  /** What the group is called; the item's name where a form has several. */
  legend?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [pasted, setPasted] = useState('');
  if (tracking === 'none') {
    return null;
  }
  const check = arrivingCheck(tracking, quantity, value);
  const isRepeated = (code: string) => check.repeated.has(code.trim().toLowerCase());

  if (tracking === 'serial') {
    const slots = serialSlots(value.serials, quantity);
    const setSerial = (index: number, code: string) =>
      onChange({ ...value, serials: slots.map((current, at) => (at === index ? code : current)) });
    const addPasted = () => {
      const codes = splitSerials(pasted).filter(
        (code) => !slots.some((current) => current.trim().toLowerCase() === code.toLowerCase()),
      );
      const next = [...slots];
      for (const code of codes) {
        const empty = next.findIndex((current) => current.trim() === '');
        if (empty === -1) {
          next.push(code);
        } else {
          next[empty] = code;
        }
      }
      onChange({ ...value, serials: next });
      setPasted('');
    };
    return (
      <fieldset className="flex flex-col gap-3 rounded-md border border-border-subtle p-3">
        <legend className="px-1 text-sm font-medium text-content">
          {legend ?? t('inventory.lots.serials')}
        </legend>
        <ol className="grid gap-2 sm:grid-cols-2">
          {slots.map((code, index) => (
            <li key={index} className="flex flex-col gap-1">
              <label htmlFor={`${id}-serial-${index}`} className="text-xs text-content-muted">
                {t('inventory.lots.serialNumber', { index: index + 1 })}
              </label>
              <span className="flex items-center gap-2">
                <input
                  id={`${id}-serial-${index}`}
                  dir="ltr"
                  maxLength={100}
                  autoComplete="off"
                  aria-invalid={isRepeated(code)}
                  className={inputClass}
                  value={code}
                  onChange={(event) => setSerial(index, event.target.value)}
                />
                {isRepeated(code) ? (
                  <span className="text-xs whitespace-nowrap text-danger">
                    {t('inventory.lots.repeated')}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        <Field label={t('inventory.lots.paste')} hint={t('inventory.lots.pasteHint')}>
          {(fieldId, describedBy) => (
            <textarea
              id={fieldId}
              aria-describedby={describedBy}
              dir="ltr"
              rows={3}
              className={inputClass}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
            />
          )}
        </Field>
        <button
          type="button"
          className={`${buttonClass.secondary} self-start`}
          disabled={splitSerials(pasted).length === 0}
          onClick={addPasted}
        >
          {t('inventory.lots.addPasted')}
        </button>
        <RunningTotal
          total={check.total}
          quantity={quantity}
          complete={check.complete}
          unit={unit}
        />
      </fieldset>
    );
  }

  const rows = value.batches.length === 0 ? NO_ARRIVING.batches : value.batches;
  const setRow = (index: number, patch: Partial<ArrivingBatch>) =>
    onChange({
      ...value,
      batches: rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    });
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border-subtle p-3">
      <legend className="px-1 text-sm font-medium text-content">
        {legend ?? t('inventory.lots.batches')}
      </legend>
      <ul className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <li key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_auto_8rem_auto]">
            <Field label={t('inventory.lots.batchCode', { index: index + 1 })}>
              {(fieldId) => (
                <input
                  id={fieldId}
                  dir="ltr"
                  maxLength={100}
                  autoComplete="off"
                  aria-invalid={isRepeated(row.code)}
                  className={inputClass}
                  value={row.code}
                  onChange={(event) => setRow(index, { code: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('inventory.lots.expiresOn')}>
              {(fieldId) => (
                <input
                  id={fieldId}
                  type="date"
                  className={inputClass}
                  value={row.expiresOn}
                  onChange={(event) => setRow(index, { expiresOn: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('inventory.lots.batchQuantity')}>
              {(fieldId) => (
                <input
                  id={fieldId}
                  inputMode="decimal"
                  dir="ltr"
                  pattern={QUANTITY_PATTERN}
                  className={inputClass}
                  placeholder={rows.length === 1 ? quantity : ''}
                  value={row.quantity}
                  onChange={(event) => setRow(index, { quantity: event.target.value.trim() })}
                />
              )}
            </Field>
            {rows.length === 1 ? (
              <span />
            ) : (
              <button
                type="button"
                className={buttonClass.ghost}
                aria-label={t('inventory.lots.removeBatch', { index: index + 1 })}
                onClick={() =>
                  onChange({ ...value, batches: rows.filter((_, at) => at !== index) })
                }
              >
                {t('inventory.lots.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-content-muted">{t('inventory.lots.batchHint')}</p>
      <button
        type="button"
        className={`${buttonClass.secondary} self-start`}
        onClick={() =>
          onChange({ ...value, batches: [...rows, { code: '', expiresOn: '', quantity: '' }] })
        }
      >
        {t('inventory.lots.addBatch')}
      </button>
      <RunningTotal total={check.total} quantity={quantity} complete={check.complete} unit={unit} />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Stock leaving: the choice
// ---------------------------------------------------------------------------

/**
 * What a leaving picker settled on, for the request: the lots named (none
 * when the item has none to name), and an expired batch confirmed with why.
 */
export interface LeavingLots {
  /** False while the lots are read, or when the choice does not add up yet. */
  ready: boolean;
  lots?: { lotId: string; quantity: string }[];
  allowExpired?: true;
  /** Why an expired batch is used, when the picker asked for it itself. */
  reason?: string;
}

/**
 * The lots stock leaving takes when the person names none: in the order the
 * server gives them — the earliest expiry first, then the oldest — up to the
 * quantity, passing over expired batches.
 */
export function suggestLeaving(
  lots: readonly Pick<ItemLot, 'lotId' | 'expiresOn' | 'onHand'>[],
  quantity: string,
  today = todayInput(),
): Record<string, string> {
  const chosen: Record<string, string> = {};
  if (!isPositiveQuantity(quantity)) {
    return chosen;
  }
  let left = units(quantity);
  for (const lot of lots) {
    if (left <= 0n) {
      break;
    }
    if (isExpired(lot.expiresOn, today)) {
      continue;
    }
    const held = units(lot.onHand);
    const take = held < left ? held : left;
    if (take > 0n) {
      chosen[lot.lotId] = decimal(take);
      left -= take;
    }
  }
  return chosen;
}

/** The item's lots held at a location, earliest expiry first. */
export function useItemLots(itemId: string, locationId: string, enabled = true) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.itemLots(itemId, locationId),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/items/{itemId}/lots', {
          params: { path: { itemId }, query: { locationId } },
        })
      ).data!.items,
    enabled: enabled && itemId !== '' && locationId !== '',
  });
}

/**
 * Which serial numbers or batches leave a location. The earliest expiry is
 * proposed; the person may choose others. With an item whose tracking is not
 * known here (a sales order line), what the location holds says it: nothing
 * listed, nothing to choose.
 *
 * `expired` says what an expired batch may do: `confirm` — be chosen once the
 * person confirms it and says why (in `formReason` when the form has its own
 * reason, otherwise here); `never` — not be chosen; `allowed` — be chosen,
 * the request already giving its reason. With `optional`, nothing is proposed
 * and nothing chosen leaves the choice to the server.
 */
export function LotsLeaving({
  itemId,
  tracking,
  locationId,
  quantity,
  unit,
  onChange,
  expired = 'confirm',
  formReason,
  optional = false,
  legend,
  hint,
  initial,
}: {
  itemId: string;
  tracking?: ItemTracking | undefined;
  locationId: string;
  quantity: string;
  unit?: Unit | undefined;
  onChange: (lots: LeavingLots) => void;
  expired?: 'confirm' | 'never' | 'allowed';
  formReason?: string | undefined;
  optional?: boolean;
  legend?: string;
  hint?: string;
  /** A choice to start from instead of the proposal, by lot: what a refused use first asked for. */
  initial?: Readonly<Record<string, string>> | undefined;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const unitName = useUnitName();
  const id = useId();
  const tracked = tracking !== 'none';
  const lots = useItemLots(itemId, locationId, tracked);
  /** What the person chose, by lot; `null` while the proposal stands. */
  const [chosen, setChosen] = useState<Record<string, string> | null>(
    initial === undefined ? null : { ...initial },
  );
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const today = todayInput();

  const held = lots.data ?? [];
  const usable = held.filter((lot) => expired !== 'never' || !isExpired(lot.expiresOn, today));
  const kind = tracking === 'serial' || tracking === 'batch' ? tracking : held[0]?.kind;
  const proposed = optional ? {} : suggestLeaving(usable, quantity, today);
  const picked = Object.fromEntries(
    Object.entries(chosen ?? proposed).filter(
      ([lotId, amount]) => amount.trim() !== '' && usable.some((lot) => lot.lotId === lotId),
    ),
  );
  // In the location's order, earliest expiry first, whatever order they were chosen in.
  const named = held
    .filter((lot) => picked[lot.lotId] !== undefined)
    .map((lot) => ({ lotId: lot.lotId, quantity: picked[lot.lotId]!.trim() }));
  const total = addQuantities(named.map((lot) => lot.quantity));
  const expiredChosen = held.filter(
    (lot) => picked[lot.lotId] !== undefined && isExpired(lot.expiresOn, today),
  );
  const ownReason = expired === 'confirm' && formReason === undefined;
  const why = (formReason ?? reason).trim();

  // Not knowing the item's tracking, a location that lists nothing — or a
  // list this person may not read — leaves the choice to the server.
  const unknown = tracking === undefined && (lots.isError || (lots.isSuccess && held.length === 0));
  let result: LeavingLots;
  if (!tracked || unknown) {
    result = { ready: true };
  } else if (!lots.isSuccess) {
    result = { ready: false };
  } else if (optional && named.length === 0) {
    result = { ready: true };
  } else {
    const adds =
      named.every((lot) => isPositiveQuantity(lot.quantity)) &&
      (kind !== 'serial' || named.every((lot) => compareDecimals(lot.quantity, '1') === 0)) &&
      isPositiveQuantity(quantity) &&
      compareDecimals(total, quantity.trim()) === 0;
    const expiredOk =
      expiredChosen.length === 0 || expired === 'allowed' || (confirmed && why !== '');
    result = {
      ready: adds && expiredOk,
      lots: named,
      ...(expiredChosen.length > 0 && expired !== 'never' ? { allowExpired: true as const } : {}),
      ...(ownReason && expiredChosen.length > 0 ? { reason: why } : {}),
    };
  }

  // The form hears of every change to the choice; the latest `onChange` is
  // kept aside so a new function from the parent is not itself a change.
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });
  const resultText = JSON.stringify(result);
  useEffect(() => {
    report.current(JSON.parse(resultText) as LeavingLots);
  }, [resultText]);

  if (!tracked || locationId === '' || itemId === '') {
    return tracked && locationId === '' && tracking !== undefined ? (
      <p className="text-xs text-content-muted">{t('inventory.lots.chooseLocationFirst')}</p>
    ) : null;
  }
  if (lots.isPending) {
    return <p className="text-xs text-content-muted">{t('common.loading')}</p>;
  }
  if (lots.isError) {
    return tracking === undefined ? null : <InlineError onRetry={() => void lots.refetch()} />;
  }
  if (kind === undefined || held.length === 0) {
    return tracking === undefined ? null : (
      <p className="text-xs text-danger">{t('inventory.lots.noneHere')}</p>
    );
  }

  const choose = (lotId: string, amount: string | undefined) => {
    const next = { ...picked };
    if (amount === undefined) {
      delete next[lotId];
    } else {
      next[lotId] = amount;
    }
    setChosen(next);
  };
  const quantityText = (value: string) => formatQuantity(value, unit, locale, unitName);

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
      <legend className="px-1 text-sm font-medium text-content">
        {legend ??
          (kind === 'serial'
            ? t('inventory.lots.chooseSerials')
            : t('inventory.lots.chooseBatches'))}
      </legend>
      <p className="text-xs text-content-muted">
        {hint ?? (optional ? t('inventory.lots.optionalHint') : t('inventory.lots.proposedHint'))}
      </p>
      <ul className="flex flex-col divide-y divide-border-subtle text-sm">
        {held.map((lot) => {
          const isOld = isExpired(lot.expiresOn, today);
          const blocked = isOld && expired === 'never';
          const inputId = `${id}-${lot.lotId}`;
          const label = (
            <span className="flex flex-wrap items-center gap-2">
              <span dir="ltr" className="font-medium text-content">
                {lot.code}
              </span>
              <LotExpiry expiresOn={lot.expiresOn} />
              {kind === 'batch' ? (
                <span className="text-xs text-content-muted tabular-nums">
                  {t('inventory.lots.heldHere', { quantity: quantityText(lot.onHand) })}
                </span>
              ) : null}
              {blocked ? (
                <span className="text-xs text-content-muted">{t('inventory.lots.notSent')}</span>
              ) : null}
            </span>
          );
          return (
            <li
              key={lot.lotId}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            >
              {kind === 'serial' ? (
                <span className="flex items-center gap-2">
                  <input
                    id={inputId}
                    type="checkbox"
                    disabled={blocked}
                    checked={picked[lot.lotId] !== undefined}
                    onChange={(event) => choose(lot.lotId, event.target.checked ? '1' : undefined)}
                  />
                  <label htmlFor={inputId}>{label}</label>
                </span>
              ) : (
                <>
                  <label htmlFor={inputId}>{label}</label>
                  <input
                    id={inputId}
                    inputMode="decimal"
                    dir="ltr"
                    pattern={QUANTITY_PATTERN}
                    disabled={blocked}
                    aria-invalid={
                      picked[lot.lotId] !== undefined &&
                      isQuantity(picked[lot.lotId]!) &&
                      compareDecimals(picked[lot.lotId]!.trim(), lot.onHand) > 0
                    }
                    className={`${inputClass} w-28`}
                    value={picked[lot.lotId] ?? ''}
                    onChange={(event) => {
                      const amount = event.target.value.trim();
                      choose(lot.lotId, amount === '' ? undefined : amount);
                    }}
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {optional && named.length === 0 ? null : (
        <RunningTotal
          total={total}
          quantity={quantity}
          complete={isPositiveQuantity(quantity) && compareDecimals(total, quantity.trim()) === 0}
          unit={unit}
        />
      )}
      {expiredChosen.length > 0 && expired === 'confirm' ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-warning bg-warning-subtle p-3 text-sm text-content"
        >
          <ul className="list-disc ps-5">
            {expiredChosen.map((lot) => (
              <li key={lot.lotId}>
                {t('inventory.lots.expiredWarning', {
                  code: lot.code,
                  date: formatCalendarDate(lot.expiresOn!, { locale }),
                })}
              </li>
            ))}
          </ul>
          <span className="flex items-center gap-2">
            <input
              id={`${id}-confirm`}
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <label htmlFor={`${id}-confirm`} className="font-medium">
              {t('inventory.lots.confirmExpired')}
            </label>
          </span>
          {ownReason ? (
            <Field label={t('inventory.lots.expiredReason')}>
              {(fieldId) => (
                <input
                  id={fieldId}
                  required
                  maxLength={1000}
                  className={inputClass}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
          ) : (
            <p className="text-xs">{t('inventory.lots.expiredReasonInForm')}</p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Whether every picker on a form is ready: a line with a picker that has not reported is not. */
export function leavingReady(
  results: Readonly<Record<string, LeavingLots | undefined>>,
  keysWithPicker: readonly string[],
): boolean {
  return keysWithPicker.every((key) => results[key]?.ready === true);
}

/** The body fields a leaving choice adds: the lots named and, for an expired batch, the confirmation. */
export function leavingBody(result: LeavingLots | undefined): {
  lots?: { lotId: string; quantity: string }[];
  allowExpired?: boolean;
} {
  if (result?.lots === undefined || result.lots.length === 0) {
    return {};
  }
  return {
    lots: result.lots,
    ...(result.allowExpired === true ? { allowExpired: true } : {}),
  };
}
