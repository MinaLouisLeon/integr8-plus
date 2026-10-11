import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ItemRow, keys, type StockCountDetail, useOperations } from '../api.js';
import { memberName, useMembers } from '../crm/lead-parts.js';
import { BackLink, buttonClass, cardClass, Failure, inputClass, Loading } from '../ui.js';
import { formatQuantity, ItemPicker, useUnitName } from './inventory-parts.js';

/**
 * A stock count (CRM/ERP plan, phase E1): what was found at a location,
 * against what the system holds. Posting adjusts stock to what was counted,
 * once, naming who posted it.
 */

interface Line {
  item: Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'>;
  counted: string;
  onHand: string;
}

function linesOf(detail: StockCountDetail): Line[] {
  return detail.lines.map((line) => ({
    item: line.item,
    counted: line.countedQuantity,
    onHand: line.onHand,
  }));
}

export function StockCountScreen({ countId }: { countId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const members = useMembers();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [adding, setAdding] = useState<Line['item'] | null>(null);

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
            lines: next.map((line) => ({
              itemId: line.item.id,
              countedQuantity: line.counted.trim(),
            })),
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
  const draftValid = shown.every((line) => /^\d{1,16}(\.\d{1,4})?$/u.test(line.counted.trim()));
  const error = [save.error, post.error, cancel.error].find((candidate) => candidate !== null);
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
              {shown.map((line, index) => (
                <li
                  key={line.item.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <label htmlFor={`counted-${line.item.id}`} className="flex min-w-0 flex-col">
                    <span className="text-content">{line.item.name}</span>
                    <span className="text-xs text-content-muted tabular-nums">
                      {t('inventory.counts.systemHolds', {
                        quantity: formatQuantity(line.onHand, line.item.unit, locale, unitName),
                      })}
                    </span>
                  </label>
                  <span className="flex items-center gap-2">
                    <input
                      id={`counted-${line.item.id}`}
                      required
                      inputMode="decimal"
                      dir="ltr"
                      pattern="\d{1,16}(\.\d{1,4})?"
                      className={`${inputClass} w-32`}
                      value={line.counted}
                      onChange={(event) =>
                        setLines(
                          shown.map((candidate, at) =>
                            at === index
                              ? { ...candidate, counted: event.target.value.trim() }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      onClick={() => setLines(shown.filter((_, at) => at !== index))}
                    >
                      {t('inventory.counts.removeLine')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {unlisted.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {unlisted.map((row) => (
                  <button
                    key={row.item.id}
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() =>
                      setLines([...shown, { item: row.item, counted: '', onHand: row.onHand }])
                    }
                  >
                    {t('inventory.counts.addNamed', { name: row.item.name })}
                  </button>
                ))}
              </div>
            ) : null}
            <ItemPicker
              label={t('inventory.counts.addItem')}
              value={adding}
              onChange={(item) => {
                if (item !== null && !shown.some((line) => line.item.id === item.id)) {
                  setLines([...shown, { item, counted: '', onHand: '0' }]);
                }
                setAdding(null);
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
                <tr key={line.item.id}>
                  <td className="py-2 text-content">{line.item.name}</td>
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
