import { hasFeature } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, cardClass, DashboardBackLink, Failure, InlineError, Loading } from '../ui.js';
import { formatQuantity, MoveStockDialog, useUnitName } from './inventory-parts.js';

/**
 * The inventory's front page (CRM/ERP plan, phase E1): what is running low,
 * what moved last, and — for those who may — moving stock and checking that
 * every balance still equals its ledger.
 */
export function InventoryOverviewScreen() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const unitName = useUnitName();
  const [moving, setMoving] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'inventory');
  const permissions = me.data?.permissions ?? [];
  const allowed = permissions.includes('inventory.read');
  const canMove = permissions.includes('inventory.move');
  const canManage = permissions.includes('inventory.manage');

  const low = useQuery({
    queryKey: keys.balances({ belowMinimum: true }),
    queryFn: async () =>
      (await client.GET('/v1/inventory/balances', { params: { query: { belowMinimum: 'true' } } }))
        .data!.items,
    enabled: enabled && allowed,
  });
  const recent = useQuery({
    queryKey: keys.movements({ limit: 10 }),
    queryFn: async () =>
      (await client.GET('/v1/inventory/movements', { params: { query: { limit: 10 } } })).data!
        .items,
    enabled: enabled && allowed,
  });
  const reconcile = useMutation({
    mutationFn: async () => (await client.GET('/v1/inventory/reconcile')).data!,
  });

  if (me.isPending) {
    return <Loading />;
  }
  if (me.isError) {
    return <Failure error={me.error} onRetry={() => void me.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('inventory.overview.title')}</h1>
          <p className="max-w-prose text-sm text-content-muted">{t('inventory.overview.intro')}</p>
        </div>
        {enabled && allowed && canMove ? (
          <button type="button" className={buttonClass.primary} onClick={() => setMoving(true)}>
            {t('inventory.move.title')}
          </button>
        ) : null}
      </header>

      {!enabled || !allowed ? (
        <p
          role="status"
          className="rounded-lg border border-border-subtle bg-surface-muted p-4 text-sm text-content"
        >
          {enabled ? t('errors.forbidden') : t('inventory.overview.notEnabled')}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card to={paths.items} title={t('inventory.items.title')} note={t('nav.hint.items')} />
            <Card
              to={paths.stockLocations}
              title={t('inventory.locations.title')}
              note={t('nav.hint.stockLocations')}
            />
          </div>

          <section aria-labelledby="inventory-low" className={cardClass}>
            <h2 id="inventory-low" className="text-base font-semibold text-content">
              {t('inventory.overview.lowStock')}
            </h2>
            {low.isPending ? (
              <Loading />
            ) : low.isError ? (
              <InlineError onRetry={() => void low.refetch()} />
            ) : low.data.length === 0 ? (
              <p className="text-sm text-content-muted">{t('inventory.overview.noLowStock')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {low.data.map((row) => (
                  <li
                    key={`${row.item.id}-${row.location.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span>
                      <AppLink to={paths.item(row.item.id)}>{row.item.name}</AppLink>
                      <span className="text-content-muted"> · {row.location.name}</span>
                    </span>
                    <span className="text-content tabular-nums">
                      {t('inventory.overview.lowLine', {
                        onHand: formatQuantity(row.onHand, row.item.unit, locale, unitName),
                        minimum: formatQuantity(row.minimum ?? '0', undefined, locale, unitName),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="inventory-recent" className={cardClass}>
            <h2 id="inventory-recent" className="text-base font-semibold text-content">
              {t('inventory.overview.recent')}
            </h2>
            {recent.isPending ? (
              <Loading />
            ) : recent.isError ? (
              <InlineError onRetry={() => void recent.refetch()} />
            ) : recent.data.length === 0 ? (
              <p className="text-sm text-content-muted">{t('inventory.overview.noMovements')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {recent.data.map((movement) => (
                  <li
                    key={movement.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span>
                      <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
                        {t(`inventory.movement.${movement.kind}`)}
                      </span>{' '}
                      <AppLink to={paths.item(movement.item.id)}>{movement.item.name}</AppLink>
                      <span className="text-content-muted"> · {movement.location.name}</span>
                    </span>
                    <span className="flex items-center gap-3 text-content tabular-nums">
                      <span dir="ltr">
                        {formatQuantity(movement.quantity, movement.item.unit, locale, unitName)}
                      </span>
                      <span className="text-xs text-content-muted">
                        {formatDateTime(movement.occurredAt, { locale })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManage ? (
            <section aria-labelledby="inventory-reconcile" className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="inventory-reconcile" className="text-base font-semibold text-content">
                  {t('inventory.overview.reconcile')}
                </h2>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={reconcile.isPending}
                  onClick={() => reconcile.mutate()}
                >
                  {reconcile.isPending
                    ? t('inventory.overview.reconciling')
                    : t('inventory.overview.reconcileNow')}
                </button>
              </div>
              <p className="text-sm text-content-muted">{t('inventory.overview.reconcileIntro')}</p>
              {reconcile.isError ? <Failure error={reconcile.error} /> : null}
              {reconcile.data === undefined ? null : reconcile.data.discrepancies.length === 0 ? (
                <p role="status" className="text-sm text-success">
                  {t('inventory.overview.reconciled')}
                </p>
              ) : (
                <p role="alert" className="text-sm text-danger">
                  {t('inventory.overview.discrepancies', {
                    count: reconcile.data.discrepancies.length,
                  })}
                </p>
              )}
            </section>
          ) : null}
        </>
      )}

      {moving ? <MoveStockDialog canSeeCosts={canMove} onClose={() => setMoving(false)} /> : null}
    </div>
  );
}

function Card({ to, title, note }: { to: string; title: string; note: string }) {
  return (
    <section className={cardClass}>
      <h2 className="text-base font-semibold text-content">
        <AppLink to={to}>{title}</AppLink>
      </h2>
      <p className="text-sm text-content-muted">{note}</p>
    </section>
  );
}

function AppLink({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
