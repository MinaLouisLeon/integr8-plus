import { hasFeature } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { type ItemKind, keys, type Unit, useOperations } from '../api.js';
import { SupplierPicker } from '../purchasing/purchasing-parts.js';
import {
  BackLink,
  buttonClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import {
  formatQuantity,
  ITEM_KINDS,
  KindBadge,
  UNITS,
  useCategories,
  useUnitName,
} from './inventory-parts.js';

interface Filters {
  q: string;
  kind: ItemKind | '';
  categoryId: string;
  includeArchived: boolean;
}

const noFilters: Filters = { q: '', kind: '', categoryId: '', includeArchived: false };

interface Draft {
  sku: string;
  name: string;
  kind: ItemKind;
  unit: Unit;
  categoryId: string;
  barcode: string;
  defaultUnitCost: string;
  salePrice: string;
  description: string;
  /** Whole days, as typed; empty to use the supplier's. */
  leadTimeDays: string;
  /** The supplier reorders go to, by id; empty for none. Chosen from a picker, never typed. */
  preferredSupplierId: string;
}

const emptyDraft: Draft = {
  sku: '',
  name: '',
  kind: 'stock_item',
  unit: 'each',
  categoryId: '',
  barcode: '',
  defaultUnitCost: '',
  salePrice: '',
  description: '',
  leadTimeDays: '',
  preferredSupplierId: '',
};

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** The catalogue (CRM/ERP plan, phase E1): what the company stocks, buys, uses and sells. */
export function ItemListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const unitName = useUnitName();
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [applied, setApplied] = useState<Filters>(noFilters);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const categories = useCategories();
  const rowMenu = useRowMenu();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  const canManage = permissions.includes('inventory.manage');
  const seesCosts = permissions.includes('inventory.move');
  const choosesSupplier =
    me.data !== undefined &&
    hasFeature(me.data.features, 'purchasing') &&
    permissions.includes('purchasing.read');

  const query = {
    ...(applied.q === '' ? {} : { q: applied.q }),
    ...(applied.kind === '' ? {} : { kind: [applied.kind] }),
    ...(applied.categoryId === '' ? {} : { categoryId: applied.categoryId }),
    ...(applied.includeArchived ? { includeArchived: 'true' as const } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: keys.items(query),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/inventory/items', {
          params: {
            query: {
              ...query,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              limit: 50,
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const body = {
    sku: draft.sku.trim(),
    name: draft.name.trim(),
    kind: draft.kind,
    unit: draft.unit,
    categoryId: orNull(draft.categoryId),
    barcode: orNull(draft.barcode),
    defaultUnitCost: orNull(draft.defaultUnitCost),
    salePrice: orNull(draft.salePrice),
    description: orNull(draft.description),
    ...(draft.leadTimeDays.trim() === '' ? {} : { leadTimeDays: Number(draft.leadTimeDays) }),
    ...(draft.preferredSupplierId === '' ? {} : { preferredSupplierId: draft.preferredSupplierId }),
  };
  const bodyText = JSON.stringify(body);
  const idempotencyKey = useMemo(() => (bodyText === '' ? '' : crypto.randomUUID()), [bodyText]);
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/items', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: (item) => navigate(paths.item(item.id)),
  });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = JSON.stringify(applied) !== JSON.stringify(noFilters);
  const ready = body.sku !== '' && body.name !== '';

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('inventory.items.title')}</h1>
        {canManage ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => {
              create.reset();
              setDraft(emptyDraft);
              setCreating(true);
            }}
          >
            {t('inventory.items.new')}
          </button>
        ) : null}
      </header>

      <form
        aria-label={t('inventory.items.filters')}
        className="grid gap-3 rounded-lg border border-border-subtle bg-surface p-4 sm:grid-cols-3 sm:items-end"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <Field label={t('inventory.items.search')} className="sm:col-span-3">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('inventory.items.fields.kind')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.kind}
              onChange={(event) =>
                setFilters({ ...filters, kind: event.target.value as ItemKind | '' })
              }
            >
              <option value="">{t('inventory.items.anyKind')}</option>
              {ITEM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`inventory.kind.${kind}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('inventory.items.fields.category')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.categoryId}
              onChange={(event) => setFilters({ ...filters, categoryId: event.target.value })}
            >
              <option value="">{t('inventory.items.anyCategory')}</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={filters.includeArchived}
            onChange={(event) => setFilters({ ...filters, includeArchived: event.target.checked })}
          />
          {t('inventory.items.includeArchived')}
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <button type="submit" className={buttonClass.primary}>
            {t('inventory.items.apply')}
          </button>
          {filtered ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                setFilters(noFilters);
                setApplied(noFilters);
              }}
            >
              {t('inventory.items.clear')}
            </button>
          ) : null}
        </div>
      </form>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('inventory.items.empty') : t('inventory.items.emptyAll')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              onContextMenu={rowMenu({ kind: 'item', id: item.id, label: item.name }, () => [
                {
                  key: 'open',
                  label: t('operations.rowActions.open'),
                  onSelect: () => navigate(paths.item(item.id)),
                },
              ])}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <a
                  href={paths.item(item.id)}
                  className="truncate font-medium text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.item(item.id));
                  }}
                >
                  {item.name}
                </a>
                <span className="truncate text-sm text-content-muted">
                  <span dir="ltr">{item.sku}</span>
                  {item.barcode === null ? null : (
                    <span dir="ltr" className="ms-2">
                      {item.barcode}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.kind === 'stock_item' ? (
                  <span className="text-sm text-content tabular-nums">
                    {formatQuantity(item.onHand, item.unit, locale, unitName)}
                  </span>
                ) : null}
                {item.archivedAt === null ? null : (
                  <span className="text-xs text-content-muted">
                    {t('inventory.items.archived')}
                  </span>
                )}
                <KindBadge kind={item.kind} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <button
          type="button"
          className={`${buttonClass.secondary} self-center`}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('inventory.items.loadMore')}
        </button>
      ) : null}

      {creating ? (
        <Dialog
          title={t('inventory.items.new')}
          wide
          onClose={() => setCreating(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setCreating(false)}
              >
                {t('inventory.items.cancel')}
              </button>
              <button
                type="submit"
                form="inventory-new-item"
                className={buttonClass.primary}
                disabled={!ready || create.isPending}
              >
                {create.isPending ? t('inventory.items.creating') : t('inventory.items.create')}
              </button>
            </>
          }
        >
          <form
            id="inventory-new-item"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready) {
                create.mutate();
              }
            }}
          >
            <ItemFields
              draft={draft}
              onChange={setDraft}
              categories={categories.data ?? []}
              seesCosts={seesCosts}
              choosesSupplier={choosesSupplier}
            />
            {create.isError ? (
              <div className="sm:col-span-2">
                <Failure error={create.error} />
              </div>
            ) : null}
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

export type { Draft as ItemDraft };
export { emptyDraft as emptyItemDraft };

/** The item form's fields, shared with the item screen's edit form. */
export function ItemFields({
  draft,
  onChange,
  categories,
  seesCosts,
  kindLocked = false,
  choosesSupplier = false,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  categories: readonly { id: string; name: string; archived: boolean }[];
  seesCosts: boolean;
  /** An item that holds stock stays a stock item. */
  kindLocked?: boolean;
  /** Whether the seat sees suppliers, and so chooses the item's preferred one. */
  choosesSupplier?: boolean;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <>
      <Field label={t('inventory.items.fields.sku')}>
        {(id) => (
          <input
            id={id}
            required
            dir="ltr"
            maxLength={64}
            className={inputClass}
            value={draft.sku}
            onChange={(event) => set('sku', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('inventory.items.fields.name')}>
        {(id) => (
          <input
            id={id}
            required
            maxLength={200}
            className={inputClass}
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('inventory.items.fields.kind')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={draft.kind}
            disabled={kindLocked}
            onChange={(event) => set('kind', event.target.value as ItemKind)}
          >
            {ITEM_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`inventory.kind.${kind}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('inventory.items.fields.unit')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={draft.unit}
            onChange={(event) => set('unit', event.target.value as Unit)}
          >
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(`inventory.unit.${unit}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('inventory.items.fields.category')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={draft.categoryId}
            onChange={(event) => set('categoryId', event.target.value)}
          >
            <option value="">{t('inventory.items.noCategory')}</option>
            {categories
              .filter((category) => !category.archived || category.id === draft.categoryId)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </select>
        )}
      </Field>
      <Field label={t('inventory.items.fields.barcode')}>
        {(id) => (
          <input
            id={id}
            dir="ltr"
            maxLength={64}
            className={inputClass}
            value={draft.barcode}
            onChange={(event) => set('barcode', event.target.value)}
          />
        )}
      </Field>
      {seesCosts ? (
        <Field
          label={t('inventory.items.fields.defaultUnitCost')}
          hint={t('inventory.items.costHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              inputMode="decimal"
              dir="ltr"
              pattern="\d{1,16}(\.\d{1,4})?"
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.defaultUnitCost}
              onChange={(event) => set('defaultUnitCost', event.target.value.trim())}
            />
          )}
        </Field>
      ) : null}
      <Field label={t('inventory.items.fields.salePrice')} hint={t('inventory.items.costHint')}>
        {(id, describedBy) => (
          <input
            id={id}
            inputMode="decimal"
            dir="ltr"
            pattern="\d{1,16}(\.\d{1,4})?"
            aria-describedby={describedBy}
            className={inputClass}
            value={draft.salePrice}
            onChange={(event) => set('salePrice', event.target.value.trim())}
          />
        )}
      </Field>
      <Field
        label={t('inventory.items.fields.leadTimeDays')}
        hint={t('inventory.items.leadTimeHint')}
      >
        {(id, describedBy) => (
          <input
            id={id}
            inputMode="numeric"
            dir="ltr"
            pattern="\d{1,4}"
            aria-describedby={describedBy}
            className={inputClass}
            value={draft.leadTimeDays}
            onChange={(event) => set('leadTimeDays', event.target.value.trim())}
          />
        )}
      </Field>
      {choosesSupplier ? (
        <Field
          label={t('inventory.preferredSupplier.label')}
          hint={t('inventory.preferredSupplier.hint')}
        >
          {(id, describedBy) => (
            <SupplierPicker
              id={id}
              describedBy={describedBy}
              value={draft.preferredSupplierId}
              noneLabel={t('inventory.preferredSupplier.none')}
              onChange={(supplierId) => set('preferredSupplierId', supplierId)}
            />
          )}
        </Field>
      ) : null}
      <Field label={t('inventory.items.fields.description')} className="sm:col-span-2">
        {(id) => (
          <textarea
            id={id}
            rows={3}
            maxLength={10_000}
            className={inputClass}
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
          />
        )}
      </Field>
    </>
  );
}
