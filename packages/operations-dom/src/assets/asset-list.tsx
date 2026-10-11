import { ASSET_STATUSES } from '@integr8/core';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type AssetStatus, keys, useOperations } from '../api.js';
import {
  buttonClass,
  DashboardBackLink,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import {
  AssetStatusBadge,
  ConditionBadge,
  NewAssetDialog,
  useAssetAccess,
  WarrantyBadge,
} from './asset-parts.js';
import { AssetTagSheet } from './asset-tag.js';

/**
 * The company's asset register (CRM/ERP plan, phase E3): every machine it
 * services, found by number, tag, serial, name or customer, with those whose
 * warranty needs attention flagged.
 */
export function AssetListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const access = useAssetAccess();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [status, setStatus] = useState<AssetStatus | ''>('');
  const [warranty, setWarranty] = useState<'' | 'expiring' | 'expired'>('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });

  const query = {
    ...(searched === '' ? {} : { q: searched }),
    ...(status === '' ? {} : { status: [status] }),
    ...(warranty === '' ? {} : { warranty }),
    limit: 50,
  };
  const assets = useInfiniteQuery({
    queryKey: keys.assets(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/assets', {
          params: { query: { ...query, ...(pageParam === 0 ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: 0,
    getNextPageParam: (page) => (page.nextCursor === null ? undefined : Number(page.nextCursor)),
  });
  const rows = assets.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = searched !== '' || status !== '' || warranty !== '';
  const toPrint = rows.filter((asset) => selected.has(asset.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <>
      <AssetTagSheet tags={toPrint} company={me.data?.company?.name ?? ''} />
      <div className="flex flex-col gap-6 text-start print:hidden">
        <DashboardBackLink />
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-content">{t('assets.title')}</h1>
          {access.manage ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={toPrint.length === 0}
                onClick={() => window.print()}
              >
                {t('assets.tags.printSelected', { count: toPrint.length })}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setCreating(true)}
              >
                {t('assets.new')}
              </button>
            </div>
          ) : null}
        </header>

        <form
          role="search"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSearched(text.trim());
          }}
        >
          <Field label={t('assets.search')} className="min-w-64 flex-1">
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
          <Field label={t('assets.anyStatus')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={status}
                onChange={(event) => setStatus(event.target.value as AssetStatus | '')}
              >
                <option value="">{t('assets.anyStatus')}</option>
                {ASSET_STATUSES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {t(`assets.status.${candidate}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('assets.warrantyFilter')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={warranty}
                onChange={(event) => setWarranty(event.target.value as '' | 'expiring' | 'expired')}
              >
                <option value="">{t('assets.anyWarranty')}</option>
                <option value="expiring">{t('assets.warranty.expiring')}</option>
                <option value="expired">{t('assets.warranty.expired')}</option>
              </select>
            )}
          </Field>
          <button type="submit" className={buttonClass.secondary}>
            {t('inventory.items.apply')}
          </button>
        </form>

        {assets.isPending ? (
          <Loading />
        ) : assets.isError ? (
          <Failure error={assets.error} onRetry={() => void assets.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-content-muted">
            {filtered ? t('assets.empty') : t('assets.emptyAll')}
          </p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
              {rows.map((asset) => (
                <li
                  key={asset.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  onContextMenu={rowMenu(
                    { kind: 'asset', id: asset.id, label: asset.reference },
                    () => [
                      {
                        key: 'open',
                        label: t('operations.rowActions.open'),
                        onSelect: () => navigate(paths.asset(asset.id)),
                      },
                    ],
                  )}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    {access.manage ? (
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={t('assets.tags.select', { reference: asset.reference })}
                        checked={selected.has(asset.id)}
                        onChange={() => toggle(asset.id)}
                      />
                    ) : null}
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <a
                          href={paths.asset(asset.id)}
                          className="font-medium text-accent underline-offset-4 hover:underline"
                          onClick={(event) => {
                            event.preventDefault();
                            navigate(paths.asset(asset.id));
                          }}
                        >
                          <span dir="ltr">{asset.reference}</span> ·{' '}
                          <span dir="auto">{asset.name}</span>
                        </a>
                        <AssetStatusBadge status={asset.status} />
                        <ConditionBadge condition={asset.condition} />
                        <WarrantyBadge warranty={asset.warranty} />
                      </span>
                      <span className="truncate text-sm text-content-muted">
                        {asset.customer.name} · {asset.site.name}
                        {asset.locationNote === null ? null : ` · ${asset.locationNote}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
                    {[asset.make, asset.model].filter((part) => part !== null).join(' ') ===
                    '' ? null : (
                      <span dir="auto">
                        {[asset.make, asset.model].filter((part) => part !== null).join(' ')}
                      </span>
                    )}
                    {asset.serialNumber === null ? null : (
                      <span dir="ltr">
                        {t('assets.serialShort', { serial: asset.serialNumber })}
                      </span>
                    )}
                    {asset.warrantyExpiresOn === null ? null : (
                      <span>
                        {t('assets.warrantyUntil', {
                          date: formatDate(asset.warrantyExpiresOn, { locale }),
                        })}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {assets.hasNextPage ? (
              <button
                type="button"
                className={`${buttonClass.secondary} self-center`}
                disabled={assets.isFetchingNextPage}
                onClick={() => void assets.fetchNextPage()}
              >
                {t('assets.loadMore')}
              </button>
            ) : null}
          </>
        )}

        {creating ? <NewAssetDialog onClose={() => setCreating(false)} /> : null}
      </div>
    </>
  );
}
