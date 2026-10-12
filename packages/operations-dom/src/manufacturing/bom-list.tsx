import { formatDate, formatNumber, useTranslation } from '@integr8/i18n';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type ItemRow, keys, useOperations } from '../api.js';
import { ItemPicker } from '../inventory/inventory-parts.js';
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
import { AppLink, ManufacturingGate, useManufacturingSeat } from './manufacturing-parts.js';

const PAGE_SIZE = 50;

/**
 * Bills of materials (seventh round; ADR-0011): every item built from parts,
 * by name, and — for those who keep them — a way to start one for another
 * item.
 */
export function BomListScreen() {
  return (
    <ManufacturingGate>
      <BomList />
    </ManufacturingGate>
  );
}

function BomList() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const seat = useManufacturingSeat();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [page, setPage] = useState(1);
  const [choosing, setChoosing] = useState(false);

  const query = { ...(searched === '' ? {} : { q: searched }), page, pageSize: PAGE_SIZE };
  const list = useQuery({
    queryKey: keys.boms(query),
    queryFn: async () => (await client.GET('/v1/manufacturing/boms', { params: { query } })).data!,
    placeholderData: keepPreviousData,
  });
  const pages = list.data === undefined ? 1 : Math.max(1, Math.ceil(list.data.total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('manufacturing.boms.title')}</h1>
          <p className="max-w-prose text-sm text-content-muted">{t('manufacturing.boms.intro')}</p>
        </div>
        {seat.manage ? (
          <button type="button" className={buttonClass.primary} onClick={() => setChoosing(true)}>
            {t('manufacturing.boms.new')}
          </button>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSearched(text.trim());
        }}
      >
        <Field label={t('manufacturing.boms.search')} className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('manufacturing.boms.apply')}
        </button>
      </form>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' ? t('manufacturing.boms.emptyAll') : t('manufacturing.boms.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {list.data.items.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'bom', id: row.item.id, label: row.item.name },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.bom(row.item.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <AppLink
                    to={paths.bom(row.item.id)}
                    className="truncate font-medium text-accent underline-offset-4 hover:underline"
                  >
                    {row.item.name}
                  </AppLink>
                  <span dir="ltr" className="truncate text-sm text-content-muted">
                    {row.item.sku}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
                  <span>{t('manufacturing.boms.components', { count: row.components })}</span>
                  <span>
                    {t('manufacturing.boms.versionN', {
                      version: formatNumber(row.version, { locale }),
                    })}
                  </span>
                  <span>{formatDate(row.createdAt, { locale })}</span>
                </div>
              </li>
            ))}
          </ul>
          {pages > 1 ? (
            <nav
              aria-label={t('manufacturing.boms.pages')}
              className="flex flex-wrap items-center justify-center gap-3 text-sm text-content"
            >
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('manufacturing.boms.previous')}
              </button>
              <span>
                {t('manufacturing.boms.pageOf', {
                  page: formatNumber(page, { locale }),
                  pages: formatNumber(pages, { locale }),
                })}
              </span>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                {t('manufacturing.boms.next')}
              </button>
            </nav>
          ) : null}
        </>
      )}

      {choosing ? <NewBomDialog onClose={() => setChoosing(false)} /> : null}
    </div>
  );
}

/** Chooses the stock item a new bill is for, and opens its bill to write. */
function NewBomDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { paths, navigate } = useOperations();
  const [item, setItem] = useState<Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'> | null>(null);
  return (
    <Dialog
      title={t('manufacturing.boms.new')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('manufacturing.boms.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={item === null}
            onClick={() => {
              if (item !== null) {
                navigate(paths.bom(item.id));
              }
            }}
          >
            {t('manufacturing.boms.open')}
          </button>
        </>
      }
    >
      <p className="text-content-muted">{t('manufacturing.boms.newHint')}</p>
      <ItemPicker label={t('manufacturing.boms.chooseItem')} value={item} onChange={setItem} />
    </Dialog>
  );
}
