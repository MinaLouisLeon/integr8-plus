import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { keys, type LotHistoryEntry, type StockMovement, useOperations } from '../api.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import { formatQuantity, useUnitName } from './inventory-parts.js';
import { LotCode, LotExpiry } from './lots.js';

/**
 * Finding a serial number or batch and following it (ninth round; ADR-0013):
 * where a unit is now, and its whole path — received on which order, moved,
 * fitted on which job and to which asset, delivered to whom.
 */

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

function KindBadge({ kind }: { kind: 'serial' | 'batch' }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
      {t(`inventory.lots.kind.${kind}`)}
    </span>
  );
}

/** The serial lookup: codes starting with what was typed, capitals or not, across every item. */
export function LotLookupScreen({ initialCode = '' }: { initialCode?: string }) {
  const { t } = useTranslation();
  const { client, paths } = useOperations();
  const [text, setText] = useState(initialCode);
  const [searched, setSearched] = useState(initialCode.trim());
  const found = useQuery({
    queryKey: keys.lotSearch(searched),
    queryFn: async () =>
      (await client.GET('/v1/inventory/lots', { params: { query: { code: searched } } })).data!
        .items,
    enabled: searched !== '',
  });

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('inventory.lots.lookup.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('inventory.lots.lookup.intro')}</p>
      </header>
      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(text.trim());
        }}
      >
        <Field
          label={t('inventory.lots.lookup.code')}
          hint={t('inventory.lots.lookup.hint')}
          className="min-w-0 flex-1"
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="search"
              dir="ltr"
              maxLength={100}
              autoComplete="off"
              aria-describedby={describedBy}
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <button type="submit" className={buttonClass.primary} disabled={text.trim() === ''}>
          {t('inventory.lots.lookup.find')}
        </button>
      </form>

      {searched === '' ? null : found.isPending ? (
        <Loading />
      ) : found.isError ? (
        <Failure error={found.error} onRetry={() => void found.refetch()} />
      ) : found.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('inventory.lots.lookup.empty')}
        </p>
      ) : (
        <section aria-labelledby="lot-lookup-results" className={cardClass}>
          <h2 id="lot-lookup-results" className="text-base font-semibold text-content">
            {t('inventory.lots.lookup.results')}
          </h2>
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {found.data.map((match) => (
              <li
                key={match.lotId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <LotCode lotId={match.lotId} code={match.code} />
                  <KindBadge kind={match.kind} />
                  <LotExpiry expiresOn={match.expiresOn} />
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <AppLink to={paths.item(match.item.id)}>{match.item.name}</AppLink>
                  <span dir="ltr" className="text-xs text-content-muted">
                    {match.item.sku}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One serial number or batch: where it is now, and every movement it made, oldest first. */
export function LotScreen({ lotId }: { lotId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const unitName = useUnitName();
  const trace = useQuery({
    queryKey: keys.lot(lotId),
    queryFn: async () =>
      (await client.GET('/v1/inventory/lots/{lotId}', { params: { path: { lotId } } })).data!,
  });
  const back = <BackLink to={paths.lots} label={t('inventory.lots.trace.back')} />;
  if (trace.isPending) {
    return <Loading />;
  }
  if (trace.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={trace.error} onRetry={() => void trace.refetch()} />
      </div>
    );
  }
  const lot = trace.data;
  const quantity = (value: string) => formatQuantity(value, lot.item.unit, locale, unitName);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
          <span dir="ltr">{lot.code}</span>
          <KindBadge kind={lot.kind} />
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
          <AppLink to={paths.item(lot.item.id)}>{lot.item.name}</AppLink>
          <span dir="ltr">{lot.item.sku}</span>
          <LotExpiry expiresOn={lot.expiresOn} />
          <span>
            {t('inventory.lots.trace.created', {
              date: formatDateTime(lot.createdAt, { locale }),
            })}
          </span>
        </p>
      </header>

      <section aria-labelledby="lot-where" className={cardClass}>
        <h2 id="lot-where" className="text-base font-semibold text-content">
          {t('inventory.lots.trace.where')}
        </h2>
        {lot.stock.length === 0 ? (
          <p className="text-sm text-content-muted">{t('inventory.lots.trace.nowhere')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {lot.stock.map((row) => (
              <li
                key={row.location.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <AppLink to={paths.stockLocation(row.location.id)}>{row.location.name}</AppLink>
                  <span className="text-xs text-content-muted">
                    {t(`inventory.locationKind.${row.location.kind}`)}
                  </span>
                </span>
                <span className="text-content tabular-nums">{quantity(row.onHand)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lot-history" className={cardClass}>
        <h2 id="lot-history" className="text-base font-semibold text-content">
          {t('inventory.lots.trace.history')}
        </h2>
        {lot.history.length === 0 ? (
          <p className="text-sm text-content-muted">{t('inventory.lots.trace.noHistory')}</p>
        ) : (
          <ol className="flex flex-col border-s border-border-subtle ps-5">
            {lot.history.map((entry) => (
              <HistoryEntry
                key={entry.movementId}
                entry={entry}
                quantity={quantity(entry.quantity)}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function HistoryEntry({ entry, quantity }: { entry: LotHistoryEntry; quantity: string }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  return (
    <li className="relative flex flex-col gap-1 pb-4 text-sm">
      <span
        aria-hidden="true"
        className="absolute -start-[25px] top-1.5 size-2 rounded-full bg-accent"
      />
      <p className="flex flex-wrap items-center gap-2 text-content">
        <span className="font-medium">{t(`inventory.lots.source.${entry.source.kind}`)}</span>
        <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
          {t(`inventory.movement.${entry.kind as StockMovement['kind']}`, {
            defaultValue: entry.kind,
          })}
        </span>
        <span dir="ltr" className="tabular-nums">
          {quantity}
        </span>
        {entry.location === null ? null : (
          <AppLink to={paths.stockLocation(entry.location.id)}>{entry.location.name}</AppLink>
        )}
      </p>
      <p className="text-xs text-content-muted">
        {t('inventory.lots.trace.byOn', {
          name: entry.by.name,
          date: formatDateTime(entry.at, { locale }),
        })}
        {entry.reason === null ? null : ` · ${entry.reason}`}
      </p>
      {entry.workOrder === null && entry.assetId === null ? null : (
        <p className="flex flex-wrap gap-3 text-xs">
          {entry.workOrder === null ? null : (
            <AppLink to={paths.workOrder(entry.workOrder.id)}>
              {t('inventory.lots.trace.job', { reference: entry.workOrder.referenceLabel })}
            </AppLink>
          )}
          {entry.assetId === null ? null : (
            <AppLink to={paths.asset(entry.assetId)}>{t('inventory.lots.trace.asset')}</AppLink>
          )}
        </p>
      )}
    </li>
  );
}
