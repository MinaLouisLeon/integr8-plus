import { hasFeature } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { CsvExportButton, StockMovementsExportButton } from '../exports.js';
import { useCurrency } from '../manufacturing/manufacturing-parts.js';
import { BackLink, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import {
  cellClass,
  DEFAULT_DAYS,
  FiguresTable,
  lastDays,
  numberCellClass,
  type Period,
  PeriodForm,
  useCount,
} from './analytics-parts.js';

/**
 * Parts used on jobs (eighth round; ADR-0012), in the inventory area: part
 * lines recorded in a period, net of returns, by engineer, customer or job
 * type. Their value, at the cost recorded when used, shows only to those who
 * see costs. Those who move stock also download it, and the stock movements
 * of the same period, as CSV.
 */

type GroupBy = 'engineer' | 'customer' | 'job_type';
const GROUPS: readonly GroupBy[] = ['engineer', 'customer', 'job_type'];

export function PartsUsageScreen() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const currency = useCurrency();
  const count = useCount();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'inventory');
  const allowed = me.data?.permissions.includes('inventory.read') ?? false;
  const [query, setQuery] = useState<Period & { groupBy: GroupBy }>(() => ({
    ...lastDays(DEFAULT_DAYS),
    groupBy: 'engineer',
  }));
  const [groupBy, setGroupBy] = useState<GroupBy>(query.groupBy);
  const usage = useQuery({
    queryKey: keys.analytics('parts-usage', query),
    queryFn: async () =>
      (await client.GET('/v1/analytics/parts-usage', { params: { query } })).data!,
    enabled: enabled && allowed,
  });

  const back = (
    <BackLink
      to={paths.inventory}
      label={t('nav.backTo', { title: t('inventory.overview.title') })}
    />
  );
  if (me.isPending) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Loading />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }

  const showsValue = usage.data?.items.some((item) => item.value !== null) ?? false;

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('analytics.parts.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('analytics.parts.intro')}</p>
      </header>

      {!enabled || !allowed ? (
        <p
          role="status"
          className="rounded-lg border border-border-subtle bg-surface-muted p-4 text-sm text-content"
        >
          {enabled ? t('errors.forbidden') : t('analytics.notEnabled')}
        </p>
      ) : (
        <>
          <section aria-labelledby="analytics-parts" className={cardClass}>
            <h2 id="analytics-parts" className="sr-only">
              {t('analytics.parts.title')}
            </h2>
            <PeriodForm
              value={query}
              onApply={(period) => setQuery({ ...period, groupBy })}
              label={t('analytics.parts.title')}
            >
              <Field label={t('analytics.groupBy')}>
                {(id) => (
                  <select
                    id={id}
                    className={inputClass}
                    value={groupBy}
                    onChange={(event) => setGroupBy(event.target.value as GroupBy)}
                  >
                    {GROUPS.map((value) => (
                      <option key={value} value={value}>
                        {t(`analytics.parts.groups.${value}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </PeriodForm>
            {usage.isPending ? (
              <Loading />
            ) : usage.isError ? (
              <Failure error={usage.error} onRetry={() => void usage.refetch()} />
            ) : usage.data.items.length === 0 ? (
              <p className="text-sm text-content-muted">{t('analytics.parts.empty')}</p>
            ) : (
              <>
                <FiguresTable
                  caption={t('analytics.parts.title')}
                  head={[
                    { key: 'name', label: t(`analytics.parts.groups.${usage.data.groupBy}`) },
                    { key: 'lines', label: t('analytics.parts.lines'), numeric: true },
                    ...(showsValue
                      ? [{ key: 'value', label: t('analytics.parts.value'), numeric: true }]
                      : []),
                  ]}
                >
                  {usage.data.items.map((item) => (
                    <tr key={item.group}>
                      <th scope="row" className={`${cellClass} text-start font-medium`}>
                        <span dir="auto">{item.label === '' ? '—' : item.label}</span>
                      </th>
                      <td className={numberCellClass}>{count(item.lines)}</td>
                      {showsValue ? (
                        <td className={numberCellClass}>
                          {item.value === null ? '—' : formatAmount(item.value, currency, locale)}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </FiguresTable>
                {showsValue ? null : (
                  <p className="text-xs text-content-muted">{t('analytics.parts.noCosts')}</p>
                )}
              </>
            )}
          </section>

          <ExportsSection query={query} />
        </>
      )}
    </div>
  );
}

/** The period's figures and its stock movements as CSV, for those who move stock. */
function ExportsSection({ query }: { query: Period & { groupBy: GroupBy } }) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  if (!(me.data?.permissions.includes('inventory.move') ?? false)) {
    return null;
  }
  return (
    <section aria-labelledby="analytics-exports" className={cardClass}>
      <h2 id="analytics-exports" className="text-base font-semibold text-content">
        {t('analytics.parts.exportsTitle')}
      </h2>
      <p className="text-sm text-content-muted">
        {t('analytics.parts.exportsIntro', {
          from: formatCalendarDate(query.from, { locale }),
          to: formatCalendarDate(query.to, { locale }),
        })}
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <CsvExportButton
          permission="inventory.move"
          label={t('analytics.parts.export')}
          filename={`parts-usage-${query.from}-${query.to}.csv`}
          request={() =>
            client.GET('/v1/analytics/parts-usage.csv', { params: { query }, parseAs: 'blob' })
          }
        />
        <StockMovementsExportButton filters={{ from: query.from, to: query.to }} />
      </div>
    </section>
  );
}
