import { ApiRequestError } from '@integr8/api-client';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { type InventoryItem, keys, useOperations } from '../api.js';
import { BackLink, buttonClass, cardClass, Failure, inputClass, Loading } from '../ui.js';
import { formatAmount } from '../crm/lead-parts.js';
import { emptyItemDraft, ItemFields, type ItemDraft } from './item-list.js';
import {
  formatQuantity,
  KindBadge,
  MoveStockDialog,
  useCategories,
  useLocations,
  useUnitName,
} from './inventory-parts.js';

/**
 * One item (CRM/ERP plan, phase E1): what it is, how much of it is where,
 * where it should be reordered, and every movement it has made.
 */

function draftOf(item: InventoryItem): ItemDraft {
  return {
    sku: item.sku,
    name: item.name,
    kind: item.kind,
    unit: item.unit,
    categoryId: item.categoryId ?? '',
    barcode: item.barcode ?? '',
    defaultUnitCost: item.defaultUnitCost ?? '',
    salePrice: item.salePrice ?? '',
    description: item.description ?? '',
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

function changes(before: ItemDraft, after: ItemDraft) {
  const body: Record<string, unknown> = {};
  if (after.sku.trim() !== before.sku) body.sku = after.sku.trim();
  if (after.name.trim() !== before.name) body.name = after.name.trim();
  if (after.kind !== before.kind) body.kind = after.kind;
  if (after.unit !== before.unit) body.unit = after.unit;
  if (after.categoryId !== before.categoryId) body.categoryId = orNull(after.categoryId);
  if (after.barcode.trim() !== before.barcode) body.barcode = orNull(after.barcode);
  if (after.defaultUnitCost.trim() !== before.defaultUnitCost)
    body.defaultUnitCost = orNull(after.defaultUnitCost);
  if (after.salePrice.trim() !== before.salePrice) body.salePrice = orNull(after.salePrice);
  if (after.description.trim() !== before.description) body.description = orNull(after.description);
  return body;
}

export function ItemScreen({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const categories = useCategories();
  const locations = useLocations();
  const [editing, setEditing] = useState<ItemDraft | null>(null);
  const [levels, setLevels] = useState<Record<string, string> | null>(null);
  const [moving, setMoving] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
  });
  const currency = settings.data?.currency ?? 'EGP';

  const detail = useQuery({
    queryKey: keys.item(itemId),
    queryFn: async () =>
      (await client.GET('/v1/inventory/items/{itemId}', { params: { path: { itemId } } })).data!,
  });
  const movements = useInfiniteQuery({
    queryKey: keys.movements({ itemId }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/inventory/movements', {
          params: {
            query: { itemId, limit: 20, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: detail.data?.item.kind === 'stock_item',
  });

  const settle = async () => {
    await queries.invalidateQueries({ queryKey: ['inventory'] });
  };
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (
        await client.PATCH('/v1/inventory/items/{itemId}', {
          params: { path: { itemId } },
          body: { expectedVersion: detail.data!.item.version, ...body },
        })
      ).data!,
    onSuccess: async () => {
      setEditing(null);
      await settle();
    },
  });
  const saveLevels = useMutation({
    mutationFn: async (next: Record<string, string>) =>
      (
        await client.PUT('/v1/inventory/items/{itemId}/reorder-levels', {
          params: { path: { itemId } },
          body: {
            levels: Object.entries(next)
              .filter(([, minimum]) => minimum.trim() !== '')
              .map(([locationId, minimum]) => ({ locationId, minimum: minimum.trim() })),
          },
        })
      ).data!,
    onSuccess: async () => {
      setLevels(null);
      await settle();
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.items} label={t('inventory.items.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { item, stock, onHand, can } = detail.data;
  const seesCosts = me.data?.permissions.includes('inventory.move') ?? false;
  const conflict = save.error instanceof ApiRequestError && save.error.code === 'version_conflict';
  const category = categories.data?.find((row) => row.id === item.categoryId);
  const held = new Map(stock.map((row) => [row.location.id, row]));
  const history = movements.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold break-words text-content">{item.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
            <span dir="ltr">{item.sku}</span>
            <KindBadge kind={item.kind} />
            {item.archivedAt === null ? null : <span>{t('inventory.items.archived')}</span>}
          </div>
        </div>
        {editing === null ? (
          <div className="flex flex-wrap gap-2">
            {can.move && item.kind === 'stock_item' && item.archivedAt === null ? (
              <button type="button" className={buttonClass.primary} onClick={() => setMoving(true)}>
                {t('inventory.move.title')}
              </button>
            ) : null}
            {can.manage ? (
              <>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setEditing(draftOf(item));
                  }}
                >
                  {t('inventory.items.edit')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={save.isPending}
                  onClick={() => save.mutate({ archived: item.archivedAt === null })}
                >
                  {item.archivedAt === null
                    ? t('inventory.items.archive')
                    : t('inventory.items.restore')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {save.isError ? (
        conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
          >
            <span>{t('inventory.items.versionConflict')}</span>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                save.reset();
                setEditing(null);
                void detail.refetch();
              }}
            >
              {t('inventory.items.reload')}
            </button>
          </div>
        ) : (
          <Failure error={save.error} />
        )
      ) : null}

      {editing !== null ? (
        <form
          aria-label={t('inventory.items.edit')}
          className={cardClass}
          onSubmit={(event) => {
            event.preventDefault();
            const body = changes(draftOf(item), editing);
            if (Object.keys(body).length === 0) {
              setEditing(null);
              return;
            }
            save.mutate(body);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <ItemFields
              draft={editing}
              onChange={setEditing}
              categories={categories.data ?? []}
              seesCosts={seesCosts}
              kindLocked={item.kind === 'stock_item' && onHand !== '0'}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setEditing(null)}
            >
              {t('inventory.items.cancel')}
            </button>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={save.isPending || editing.sku.trim() === '' || editing.name.trim() === ''}
            >
              {save.isPending ? t('inventory.items.saving') : t('inventory.items.save')}
            </button>
          </div>
        </form>
      ) : (
        <section aria-labelledby="inventory-item-details" className={cardClass}>
          <h2 id="inventory-item-details" className="text-base font-semibold text-content">
            {t('inventory.items.details')}
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label={t('inventory.items.fields.unit')}>{unitName(item.unit)}</Detail>
            <Detail label={t('inventory.items.fields.category')}>{category?.name}</Detail>
            <Detail label={t('inventory.items.fields.barcode')}>
              {item.barcode === null ? null : <span dir="ltr">{item.barcode}</span>}
            </Detail>
            {item.kind === 'stock_item' ? (
              <Detail label={t('inventory.items.onHand')}>
                {formatQuantity(onHand, item.unit, locale, unitName)}
              </Detail>
            ) : null}
            {item.averageUnitCost === null ? null : (
              <Detail label={t('inventory.items.fields.averageUnitCost')}>
                {formatAmount(item.averageUnitCost, currency, locale)}
              </Detail>
            )}
            {item.defaultUnitCost === null ? null : (
              <Detail label={t('inventory.items.fields.defaultUnitCost')}>
                {formatAmount(item.defaultUnitCost, currency, locale)}
              </Detail>
            )}
            <Detail label={t('inventory.items.fields.salePrice')}>
              {item.salePrice === null ? null : formatAmount(item.salePrice, currency, locale)}
            </Detail>
            <Detail label={t('inventory.items.fields.description')} wide>
              {item.description === null ? null : (
                <span className="whitespace-pre-wrap">{item.description}</span>
              )}
            </Detail>
          </dl>
        </section>
      )}

      {item.kind === 'stock_item' ? (
        <section aria-labelledby="inventory-item-stock" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="inventory-item-stock" className="text-base font-semibold text-content">
              {t('inventory.items.stockByLocation')}
            </h2>
            {can.manage && levels === null ? (
              <button
                type="button"
                className={buttonClass.ghost}
                onClick={() => {
                  saveLevels.reset();
                  setLevels(
                    Object.fromEntries(
                      (locations.data ?? []).map((location) => [
                        location.id,
                        held.get(location.id)?.minimum ?? '',
                      ]),
                    ),
                  );
                }}
              >
                {t('inventory.items.editLevels')}
              </button>
            ) : null}
          </div>
          {levels !== null ? (
            <form
              aria-label={t('inventory.items.editLevels')}
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                saveLevels.mutate(levels);
              }}
            >
              <p className="text-sm text-content-muted">{t('inventory.items.levelsIntro')}</p>
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {(locations.data ?? []).map((location) => (
                  <li
                    key={location.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <label htmlFor={`level-${location.id}`} className="text-content">
                      {location.name}
                      <span className="ms-2 text-content-muted tabular-nums">
                        {formatQuantity(
                          held.get(location.id)?.onHand ?? '0',
                          item.unit,
                          locale,
                          unitName,
                        )}
                      </span>
                    </label>
                    <input
                      id={`level-${location.id}`}
                      inputMode="decimal"
                      dir="ltr"
                      pattern="\d{1,16}(\.\d{1,4})?"
                      className={`${inputClass} w-32`}
                      placeholder={t('inventory.items.noMinimum')}
                      value={levels[location.id] ?? ''}
                      onChange={(event) =>
                        setLevels({ ...levels, [location.id]: event.target.value.trim() })
                      }
                    />
                  </li>
                ))}
              </ul>
              {saveLevels.isError ? <Failure error={saveLevels.error} /> : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setLevels(null)}
                >
                  {t('inventory.items.cancel')}
                </button>
                <button
                  type="submit"
                  className={buttonClass.primary}
                  disabled={saveLevels.isPending}
                >
                  {saveLevels.isPending
                    ? t('inventory.items.saving')
                    : t('inventory.items.saveLevels')}
                </button>
              </div>
            </form>
          ) : stock.length === 0 ? (
            <p className="text-sm text-content-muted">{t('inventory.items.noStock')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {stock.map((row) => (
                <li
                  key={row.location.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <a
                    href={paths.stockLocation(row.location.id)}
                    className="text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.stockLocation(row.location.id));
                    }}
                  >
                    {row.location.name}
                  </a>
                  <span className="flex items-center gap-3 tabular-nums">
                    <span className="text-content">
                      {formatQuantity(row.onHand, item.unit, locale, unitName)}
                    </span>
                    {row.minimum === null ? null : (
                      <span className="text-xs text-content-muted">
                        {t('inventory.items.minimumIs', {
                          minimum: formatQuantity(row.minimum, undefined, locale, unitName),
                        })}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {item.kind === 'stock_item' ? (
        <section aria-labelledby="inventory-item-movements" className={cardClass}>
          <h2 id="inventory-item-movements" className="text-base font-semibold text-content">
            {t('inventory.items.movements')}
          </h2>
          {movements.isPending ? (
            <Loading />
          ) : movements.isError ? (
            <Failure error={movements.error} onRetry={() => void movements.refetch()} />
          ) : history.length === 0 ? (
            <p className="text-sm text-content-muted">{t('inventory.items.noMovements')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {history.map((movement) => (
                <li
                  key={movement.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span>
                    <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
                      {t(`inventory.movement.${movement.kind}`)}
                    </span>{' '}
                    <span className="text-content">{movement.location.name}</span>
                    {movement.reason === null ? null : (
                      <span className="text-content-muted"> — {movement.reason}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 tabular-nums">
                    <span dir="ltr" className="text-content">
                      {formatQuantity(movement.quantity, item.unit, locale, unitName)}
                    </span>
                    {movement.unitCost === null ? null : (
                      <span className="text-xs text-content-muted">
                        {formatAmount(movement.unitCost, currency, locale)}
                      </span>
                    )}
                    <span className="text-xs text-content-muted">
                      {formatDateTime(movement.occurredAt, { locale })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {movements.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={movements.isFetchingNextPage}
              onClick={() => void movements.fetchNextPage()}
            >
              {t('inventory.items.loadMore')}
            </button>
          ) : null}
        </section>
      ) : null}

      {moving ? (
        <MoveStockDialog item={item} canSeeCosts={seesCosts} onClose={() => setMoving(false)} />
      ) : null}
    </div>
  );
}

function Detail({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-content-muted">{label}</dt>
      <dd className="break-words text-content">{children ?? t('inventory.items.none')}</dd>
    </div>
  );
}

export { emptyItemDraft };
