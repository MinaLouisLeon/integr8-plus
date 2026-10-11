import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { memberName, useMembers } from '../crm/lead-parts.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import {
  formatQuantity,
  LocationKindBadge,
  MoveStockDialog,
  useUnitName,
} from './inventory-parts.js';

/**
 * One location (CRM/ERP plan, phase E1): what it holds, who drives it when
 * it is a van, its stock counts, and — for those who may — moving stock in
 * or out and starting a count.
 */
export function LocationScreen({ locationId }: { locationId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const members = useMembers();
  const [moving, setMoving] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const seesCosts = me.data?.permissions.includes('inventory.move') ?? false;

  const detail = useQuery({
    queryKey: keys.stockLocation(locationId),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/locations/{locationId}', {
          params: { path: { locationId } },
        })
      ).data!,
  });
  const counts = useQuery({
    queryKey: keys.stockCounts({ locationId }),
    queryFn: async () =>
      (await client.GET('/v1/inventory/counts', { params: { query: { locationId } } })).data!.items,
  });

  const settle = async () => {
    await queries.invalidateQueries({ queryKey: ['inventory'] });
  };
  const patch = useMutation({
    mutationFn: async (body: { assignedTo?: string | null; archived?: boolean }) =>
      (
        await client.PATCH('/v1/inventory/locations/{locationId}', {
          params: { path: { locationId } },
          body: { expectedVersion: detail.data!.location.version, ...body },
        })
      ).data!,
    onSuccess: settle,
  });
  const startCount = useMutation({
    mutationFn: async () =>
      (await client.POST('/v1/inventory/counts', { body: { locationId } })).data!,
    onSuccess: async (created) => {
      await settle();
      navigate(paths.stockCount(created.count.id));
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.stockLocations} label={t('inventory.locations.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { location, stock, can } = detail.data;
  const assignee = memberName(members.data, location.assignedTo);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold break-words text-content">{location.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
            <LocationKindBadge kind={location.kind} />
            {location.kind === 'van' ? (
              <span>
                {assignee === null
                  ? t('inventory.locations.unassigned')
                  : t('inventory.locations.drivenBy', { name: assignee })}
              </span>
            ) : null}
            {location.site === null ? null : <span>{location.site.name}</span>}
            {location.archivedAt === null ? null : <span>{t('inventory.locations.archived')}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can.move && location.archivedAt === null ? (
            <>
              <button type="button" className={buttonClass.primary} onClick={() => setMoving(true)}>
                {t('inventory.move.title')}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={startCount.isPending}
                onClick={() => startCount.mutate()}
              >
                {t('inventory.locations.startCount')}
              </button>
            </>
          ) : null}
          {can.manage ? (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={patch.isPending}
              onClick={() => patch.mutate({ archived: location.archivedAt === null })}
            >
              {location.archivedAt === null
                ? t('inventory.locations.archive')
                : t('inventory.locations.restore')}
            </button>
          ) : null}
        </div>
      </header>

      {patch.isError ? <Failure error={patch.error} /> : null}
      {startCount.isError ? <Failure error={startCount.error} /> : null}

      {can.manage && location.kind === 'van' ? (
        <section aria-labelledby="inventory-location-van" className={cardClass}>
          <h2 id="inventory-location-van" className="text-base font-semibold text-content">
            {t('inventory.locations.assign')}
          </h2>
          <Field
            label={t('inventory.locations.fields.assignedTo')}
            hint={t('inventory.locations.vanHint')}
          >
            {(id, describedBy) => (
              <select
                id={id}
                aria-describedby={describedBy}
                className={inputClass}
                value={location.assignedTo ?? ''}
                disabled={patch.isPending}
                onChange={(event) =>
                  patch.mutate({
                    assignedTo: event.target.value === '' ? null : event.target.value,
                  })
                }
              >
                <option value="">{t('inventory.locations.unassigned')}</option>
                {(members.data ?? [])
                  .filter(
                    (member) => member.status === 'active' || member.userId === location.assignedTo,
                  )
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        </section>
      ) : null}

      <section aria-labelledby="inventory-location-stock" className={cardClass}>
        <h2 id="inventory-location-stock" className="text-base font-semibold text-content">
          {t('inventory.locations.stock')}
        </h2>
        {stock.length === 0 ? (
          <p className="text-sm text-content-muted">{t('inventory.locations.noStock')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {stock.map((row) => (
              <li
                key={row.item.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  <a
                    href={paths.item(row.item.id)}
                    className="text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.item(row.item.id));
                    }}
                  >
                    {row.item.name}
                  </a>
                  <span dir="ltr" className="ms-2 text-content-muted">
                    {row.item.sku}
                  </span>
                </span>
                <span className="flex items-center gap-3 tabular-nums">
                  <span className="text-content">
                    {formatQuantity(row.onHand, row.item.unit, locale, unitName)}
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

      <section aria-labelledby="inventory-location-counts" className={cardClass}>
        <h2 id="inventory-location-counts" className="text-base font-semibold text-content">
          {t('inventory.counts.title')}
        </h2>
        {counts.isPending ? (
          <Loading />
        ) : counts.isError ? (
          <Failure error={counts.error} onRetry={() => void counts.refetch()} />
        ) : counts.data.length === 0 ? (
          <p className="text-sm text-content-muted">{t('inventory.locations.noCounts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {counts.data.map((count) => (
              <li key={count.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a
                  href={paths.stockCount(count.id)}
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.stockCount(count.id));
                  }}
                >
                  {t('inventory.counts.startedOn', {
                    date: formatDateTime(count.createdAt, { locale }),
                  })}
                </a>
                <span className="text-xs text-content-muted">
                  {t(`inventory.counts.status.${count.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {moving ? (
        <MoveStockDialog
          location={location}
          canSeeCosts={seesCosts}
          onClose={() => setMoving(false)}
        />
      ) : null}
    </div>
  );
}
