import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { type ItemRow, keys, type StockCountDetail, useOperations } from '../api.js';
import { memberName, useMembers } from '../crm/lead-parts.js';
import { BackLink, buttonClass, cardClass, Failure, inputClass, Loading } from '../ui.js';
import { formatQuantity, ItemPicker, useUnitName } from './inventory-parts.js';
import { LotCode, LotExpiry, TrackingBadge } from './lots.js';

/**
 * A stock count (CRM/ERP plan, phase E1): what was found at a location,
 * against what the system holds. Posting adjusts stock to what was counted,
 * once, naming who posted it.
 *
 * A tracked item is counted by serial number or batch (ADR-0013): the ones
 * the location holds are listed, and a code found that is not is added. A
 * serial number is there or not; what the count leaves out counts as none.
 */

interface Line {
  item: Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit' | 'tracking'>;
  /** A tracked item's serial number or batch: known (`id`), or a code first seen here. */
  lot: { id: string | null; code: string; expiresOn: string } | null;
  counted: string;
  onHand: string;
}

function linesOf(detail: StockCountDetail): Line[] {
  return detail.lines.map((line) => ({
    item: line.item,
    lot:
      line.lot === null
        ? null
        : { id: line.lot.id, code: line.lot.code, expiresOn: line.lot.expiresOn ?? '' },
    counted: line.countedQuantity,
    onHand: line.onHand,
  }));
}

const QUANTITY = /^\d{1,16}(\.\d{1,4})?$/u;

/** Whether a line can be saved: a quantity, a serial number 0 or 1, a new code typed. */
function lineValid(line: Line): boolean {
  const counted = line.counted.trim();
  if (!QUANTITY.test(counted)) {
    return false;
  }
  if (line.item.tracking === 'none' || line.lot === null) {
    return true;
  }
  return (
    (line.lot.id !== null || line.lot.code.trim() !== '') &&
    (line.item.tracking !== 'serial' || /^[01](\.0+)?$/u.test(counted))
  );
}

/** The lines as the API takes them: a lot by id, or a new one by its code and expiry. */
function lineBodies(lines: readonly Line[]) {
  return lines.map((line) => ({
    itemId: line.item.id,
    countedQuantity: line.counted.trim(),
    ...(line.lot === null
      ? {}
      : line.lot.id !== null
        ? { lotId: line.lot.id }
        : {
            lotCode: line.lot.code.trim(),
            ...(line.lot.expiresOn === '' ? {} : { lotExpiresOn: line.lot.expiresOn }),
          }),
  }));
}

/** Lines in groups, one per item, in the order items first appear. */
function groups(lines: readonly Line[]): { item: Line['item']; at: number[] }[] {
  const out: { item: Line['item']; at: number[] }[] = [];
  lines.forEach((line, index) => {
    const group = out.find((candidate) => candidate.item.id === line.item.id);
    if (group === undefined) {
      out.push({ item: line.item, at: [index] });
    } else {
      group.at.push(index);
    }
  });
  return out;
}

export function StockCountScreen({ countId }: { countId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const members = useMembers();
  const [lines, setLines] = useState<Line[] | null>(null);

  const detail = useQuery({
    queryKey: keys.stockCount(countId),
    queryFn: async () =>
      (await client.GET('/v1/inventory/counts/{countId}', { params: { path: { countId } } })).data!,
  });
  const location = useQuery({
    queryKey: keys.stockLocation(detail.data?.count.location.id ?? ''),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/locations/{locationId}', {
          params: { path: { locationId: detail.data!.count.location.id } },
        })
      ).data!,
    enabled: detail.data !== undefined,
  });

  const settle = async (next: StockCountDetail) => {
    queries.setQueryData(keys.stockCount(countId), next);
    await queries.invalidateQueries({ queryKey: ['inventory'] });
  };
  const save = useMutation({
    mutationFn: async (next: Line[]) =>
      (
        await client.PUT('/v1/inventory/counts/{countId}/lines', {
          params: { path: { countId } },
          body: {
            expectedVersion: detail.data!.count.version,
            lines: lineBodies(next),
          },
        })
      ).data!,
    onSuccess: async (next) => {
      setLines(null);
      await settle(next);
    },
  });
  const post = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/counts/{countId}/post', {
          params: { path: { countId } },
          body: { expectedVersion: detail.data!.count.version },
        })
      ).data!,
    onSuccess: settle,
  });
  // An item joins the count with what the location holds of it: a tracked
  // item one line per serial number or batch there.
  const adding = useMutation({
    mutationFn: async ({
      item,
      onHand,
    }: {
      item: Line['item'];
      onHand: string;
    }): Promise<Line[]> => {
      if (item.tracking === 'none') {
        return [{ item, lot: null, counted: '', onHand }];
      }
      const locationId = detail.data!.count.location.id;
      const held = await queries.fetchQuery({
        queryKey: keys.itemLots(item.id, locationId),
        queryFn: async () =>
          (
            await client.GET('/v1/inventory/items/{itemId}/lots', {
              params: { path: { itemId: item.id }, query: { locationId } },
            })
          ).data!.items,
      });
      return held.length === 0
        ? [newCode(item)]
        : held.map((lot): Line => ({
            item,
            lot: { id: lot.lotId, code: lot.code, expiresOn: lot.expiresOn ?? '' },
            counted: item.tracking === 'serial' ? '0' : '',
            onHand: lot.onHand,
          }));
    },
    onSuccess: (added) => setLines((current) => [...(current ?? []), ...added]),
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/counts/{countId}/cancel', {
          params: { path: { countId } },
          body: { expectedVersion: detail.data!.count.version },
        })
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        <BackLink to={paths.stockLocations} label={t('inventory.locations.back')} />
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { count, can } = detail.data;
  const shown = lines ?? linesOf(detail.data);
  const editing = lines !== null;
  const draftValid = shown.every(lineValid);
  const error = [save.error, post.error, cancel.error].find((candidate) => candidate !== null);
  const change = (index: number, next: Line) =>
    setLines(shown.map((candidate, at) => (at === index ? next : candidate)));
  const remove = (index: number) => setLines(shown.filter((_, at) => at !== index));
  // Items the location holds that are not on the count yet, offered first.
  const unlisted = (location.data?.stock ?? []).filter(
    (row) => !shown.some((line) => line.item.id === row.item.id),
  );

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.stockLocation(count.location.id)} label={t('inventory.counts.back')} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">
            {t('inventory.counts.heading', { location: count.location.name })}
          </h1>
          <p className="text-sm text-content-muted">
            {t(`inventory.counts.status.${count.status}`)} ·{' '}
            {t('inventory.counts.startedOn', { date: formatDateTime(count.createdAt, { locale }) })}
            {count.postedAt === null
              ? null
              : ` · ${t('inventory.counts.postedBy', {
                  name: memberName(members.data, count.postedBy) ?? '—',
                  date: formatDateTime(count.postedAt, { locale }),
                })}`}
          </p>
        </div>
        {can.edit && !editing ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              disabled={post.isPending || shown.length === 0}
              onClick={() => {
                if (window.confirm(t('inventory.counts.postConfirm'))) {
                  post.mutate();
                }
              }}
            >
              {post.isPending ? t('inventory.counts.posting') : t('inventory.counts.post')}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t('inventory.counts.cancelCount')}
            </button>
          </div>
        ) : null}
      </header>

      {error === undefined ? null : <Failure error={error} />}

      <section aria-labelledby="inventory-count-lines" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="inventory-count-lines" className="text-base font-semibold text-content">
            {t('inventory.counts.lines')}
          </h2>
          {can.edit && !editing ? (
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => {
                save.reset();
                setLines(linesOf(detail.data));
              }}
            >
              {t('inventory.counts.edit')}
            </button>
          ) : null}
        </div>
        {editing ? (
          <form
            aria-label={t('inventory.counts.edit')}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftValid) {
                save.mutate(shown);
              }
            }}
          >
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {groups(shown).map((group) =>
                group.item.tracking === 'none' ? (
                  group.at.map((index) => (
                    <CountLine
                      key={group.item.id}
                      line={shown[index]!}
                      onChange={(next) => change(index, next)}
                      onRemove={() => remove(index)}
                    />
                  ))
                ) : (
                  <li key={group.item.id} className="flex flex-col gap-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-content">{group.item.name}</span>
                        <TrackingBadge tracking={group.item.tracking} />
                      </span>
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        onClick={() => setLines([...shown, newCode(group.item)])}
                      >
                        {t('inventory.lots.count.addCode')}
                      </button>
                    </div>
                    <ul className="flex flex-col gap-1 ps-3">
                      {group.at.map((index) => (
                        <CountLine
                          key={`${shown[index]!.lot?.id ?? 'new'}:${index}`}
                          line={shown[index]!}
                          onChange={(next) => change(index, next)}
                          onRemove={() => remove(index)}
                        />
                      ))}
                    </ul>
                  </li>
                ),
              )}
            </ul>
            {adding.isError ? <Failure error={adding.error} /> : null}
            {unlisted.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {unlisted.map((row) => (
                  <button
                    key={row.item.id}
                    type="button"
                    className={buttonClass.secondary}
                    disabled={adding.isPending}
                    onClick={() => adding.mutate({ item: row.item, onHand: row.onHand })}
                  >
                    {t('inventory.counts.addNamed', { name: row.item.name })}
                  </button>
                ))}
              </div>
            ) : null}
            <ItemPicker
              label={t('inventory.counts.addItem')}
              value={null}
              onChange={(item) => {
                if (item !== null && !shown.some((line) => line.item.id === item.id)) {
                  adding.mutate({ item, onHand: '0' });
                }
              }}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setLines(null)}
              >
                {t('inventory.items.cancel')}
              </button>
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={!draftValid || save.isPending}
              >
                {save.isPending ? t('inventory.items.saving') : t('inventory.counts.save')}
              </button>
            </div>
          </form>
        ) : shown.length === 0 ? (
          <p className="text-sm text-content-muted">{t('inventory.counts.noLines')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-start text-xs text-content-muted">
              <tr>
                <th scope="col" className="py-1 text-start font-medium">
                  {t('inventory.counts.item')}
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  {count.status === 'posted'
                    ? t('inventory.counts.expected')
                    : t('inventory.counts.system')}
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  {t('inventory.counts.counted')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {detail.data.lines.map((line) => (
                <tr key={`${line.item.id}:${line.lot?.id ?? line.lot?.code ?? ''}`}>
                  <td className="py-2 text-content">
                    {line.item.name}
                    {line.lot === null ? null : (
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <LotCode lotId={line.lot.id} code={line.lot.code} />
                        <LotExpiry expiresOn={line.lot.expiresOn} />
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-end text-content tabular-nums">
                    {formatQuantity(
                      count.status === 'posted'
                        ? (line.expectedQuantity ?? line.onHand)
                        : line.onHand,
                      line.item.unit,
                      locale,
                      unitName,
                    )}
                  </td>
                  <td className="py-2 text-end text-content tabular-nums">
                    {formatQuantity(line.countedQuantity, line.item.unit, locale, unitName)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <button
        type="button"
        className={`${buttonClass.ghost} self-start`}
        onClick={() => navigate(paths.stockLocation(count.location.id))}
      >
        {t('inventory.counts.backToLocation', { location: count.location.name })}
      </button>
    </div>
  );
}

/** A code found on the shelf that the location is not known to hold. */
function newCode(item: Line['item']): Line {
  return {
    item,
    lot: { id: null, code: '', expiresOn: '' },
    // Adding a serial number is saying it is here.
    counted: item.tracking === 'serial' ? '1' : '',
    onHand: '0',
  };
}

/**
 * One line of a count being edited: an item, or one of a tracked item's
 * serial numbers (there or not) or batches (how many).
 */
function CountLine({
  line,
  onChange,
  onRemove,
}: {
  line: Line;
  onChange: (next: Line) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const unitName = useUnitName();
  const id = useId();
  const system = t('inventory.counts.systemHolds', {
    quantity: formatQuantity(line.onHand, line.item.unit, locale, unitName),
  });
  const remove = (
    <button type="button" className={buttonClass.ghost} onClick={onRemove}>
      {t('inventory.counts.removeLine')}
    </button>
  );
  const counted = (label: string) => (
    <input
      id={id}
      required
      inputMode="decimal"
      dir="ltr"
      pattern="\d{1,16}(\.\d{1,4})?"
      aria-label={label}
      className={`${inputClass} w-32`}
      value={line.counted}
      onChange={(event) => onChange({ ...line, counted: event.target.value.trim() })}
    />
  );

  if (line.lot === null) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-3 py-2">
        <label htmlFor={id} className="flex min-w-0 flex-col">
          <span className="text-content">{line.item.name}</span>
          <span className="text-xs text-content-muted tabular-nums">{system}</span>
        </label>
        <span className="flex items-center gap-2">
          <input
            id={id}
            required
            inputMode="decimal"
            dir="ltr"
            pattern="\d{1,16}(\.\d{1,4})?"
            className={`${inputClass} w-32`}
            value={line.counted}
            onChange={(event) => onChange({ ...line, counted: event.target.value.trim() })}
          />
          {remove}
        </span>
      </li>
    );
  }

  const { lot } = line;
  const name = lot.code.trim() === '' ? t('inventory.lots.count.newCode') : lot.code.trim();
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 py-1">
      {lot.id === null ? (
        <span className="flex flex-wrap items-end gap-2">
          <span className="flex flex-col gap-1">
            <label htmlFor={`${id}-code`} className="text-xs text-content-muted">
              {t('inventory.lots.count.newCode')}
            </label>
            <input
              id={`${id}-code`}
              dir="ltr"
              maxLength={100}
              autoComplete="off"
              className={`${inputClass} w-48`}
              value={lot.code}
              onChange={(event) => onChange({ ...line, lot: { ...lot, code: event.target.value } })}
            />
          </span>
          {line.item.tracking === 'batch' ? (
            <span className="flex flex-col gap-1">
              <label htmlFor={`${id}-expires`} className="text-xs text-content-muted">
                {t('inventory.lots.expiresOn')}
              </label>
              <input
                id={`${id}-expires`}
                type="date"
                className={`${inputClass} w-44`}
                value={lot.expiresOn}
                onChange={(event) =>
                  onChange({ ...line, lot: { ...lot, expiresOn: event.target.value } })
                }
              />
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <LotCode lotId={lot.id} code={lot.code} />
            <LotExpiry expiresOn={lot.expiresOn === '' ? null : lot.expiresOn} />
          </span>
          <span className="text-xs text-content-muted tabular-nums">{system}</span>
        </span>
      )}
      <span className="flex items-center gap-2">
        {line.item.tracking === 'serial' ? (
          <span className="flex items-center gap-2">
            <input
              id={id}
              type="checkbox"
              checked={/^1(\.0+)?$/u.test(line.counted.trim())}
              onChange={(event) => onChange({ ...line, counted: event.target.checked ? '1' : '0' })}
            />
            <label htmlFor={id} className="text-sm text-content">
              {t('inventory.lots.count.here', { code: name })}
            </label>
          </span>
        ) : (
          counted(t('inventory.lots.count.counted', { code: name }))
        )}
        {remove}
      </span>
    </li>
  );
}
