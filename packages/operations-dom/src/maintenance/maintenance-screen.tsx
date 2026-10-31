import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { keys, type MaintenanceStanding, useOperations } from '../api.js';
import { termReversed } from '../contracts/model.js';
import { DashboardBackLink, Failure, Field, inputClass, Loading } from '../ui.js';
import { MaintenanceStandingBadge, PlanFailureNotice } from './maintenance-parts.js';
import {
  choices,
  filterItems,
  formatMonth,
  groupByMonth,
  type MaintenanceFilters,
  NO_FILTERS,
} from './model.js';

const STANDINGS: readonly MaintenanceStanding[] = [
  'overdue',
  'upcoming',
  'created',
  'completed',
  'cancelled',
  'skipped',
];

/**
 * Maintenance (P27): what the company's plans have due in a period — jobs
 * already made, completed, overdue, and those still to come — earliest
 * first, a month at a time. Upcoming dates are worked out from each plan
 * rather than stored, so a changed plan shows its new dates at once.
 *
 * The server sends the whole period; the customer, site, job type and status
 * filters narrow what it sent, so their choices are always the ones present.
 */
export function MaintenanceScreen() {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const [range, setRange] = useState<{ from: string; to: string } | undefined>();
  // What the date boxes show; sent once the period reads forwards.
  const [draft, setDraft] = useState<{ from: string; to: string } | undefined>();
  const [filters, setFilters] = useState<MaintenanceFilters>(NO_FILTERS);

  const query = range ?? {};
  const list = useQuery({
    queryKey: keys.maintenance(query),
    queryFn: async () => (await client.GET('/v1/maintenance', { params: { query } })).data!,
    placeholderData: (previous) => previous,
  });
  // Plans the worker could not make jobs for (0063), above everything else.
  const failingQuery = { failing: 'true' as const };
  const failing = useQuery({
    queryKey: keys.maintenancePlans(failingQuery),
    queryFn: async () =>
      (await client.GET('/v1/maintenance-plans', { params: { query: failingQuery } })).data!,
  });
  const data = list.data;
  const from = draft?.from ?? data?.from ?? '';
  const to = draft?.to ?? data?.to ?? '';
  const reversed = termReversed(from, to);

  const options = useMemo(
    () => ({
      customers: choices(
        (data?.items ?? []).map((item) => item.customer),
        locale,
      ),
      sites: choices(
        (data?.items ?? [])
          .filter((item) => filters.customerId === '' || item.customer.id === filters.customerId)
          .map((item) => item.site),
        locale,
      ),
      jobTypes: choices(
        (data?.items ?? []).map((item) => item.jobType),
        locale,
      ),
    }),
    [data, filters.customerId, locale],
  );
  const groups = useMemo(
    () => groupByMonth(filterItems(data?.items ?? [], filters), locale),
    [data, filters, locale],
  );

  const setDay = (which: 'from' | 'to', value: string) => {
    if (value === '') {
      return;
    }
    const next = { from, to, [which]: value };
    setDraft(next);
    if (!termReversed(next.from, next.to)) {
      setRange(next);
    }
  };
  const link = (href: string, label: ReactNode) => (
    <a
      href={href}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('operations.maintenance.title')}</h1>
        <p className="text-sm text-content-muted">{t('operations.maintenance.intro')}</p>
      </header>

      {failing.data !== undefined && failing.data.items.length > 0 ? (
        <section aria-labelledby="failing-plans" className="flex flex-col gap-2">
          <h2 id="failing-plans" className="text-lg font-semibold text-content">
            {t('operations.maintenance.plans.failure.heading')}
          </h2>
          <ul className="flex flex-col gap-2">
            {failing.data.items.map((plan) => (
              <li key={plan.id} className="flex flex-col gap-1">
                <span dir="auto" className="text-sm font-medium text-content">
                  {link(paths.asset(plan.asset.id), plan.title)}
                  {` · ${plan.asset.reference} · ${plan.customer.name}`}
                </span>
                <PlanFailureNotice failure={plan.failure} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('operations.maintenance.from')}>
          {(id) => (
            <input
              id={id}
              type="date"
              className={inputClass}
              value={from}
              aria-invalid={reversed}
              onChange={(event) => setDay('from', event.target.value)}
            />
          )}
        </Field>
        <Field label={t('operations.maintenance.to')}>
          {(id) => (
            <input
              id={id}
              type="date"
              className={inputClass}
              value={to}
              aria-invalid={reversed}
              onChange={(event) => setDay('to', event.target.value)}
            />
          )}
        </Field>
        <Field label={t('operations.maintenance.customer')} className="min-w-44">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.customerId}
              onChange={(event) =>
                setFilters({ ...filters, customerId: event.target.value, siteId: '' })
              }
            >
              <option value="">{t('operations.maintenance.allCustomers')}</option>
              {options.customers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.maintenance.site')} className="min-w-44">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.siteId}
              onChange={(event) => setFilters({ ...filters, siteId: event.target.value })}
            >
              <option value="">{t('operations.maintenance.allSites')}</option>
              {options.sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.maintenance.fields.jobType')} className="min-w-44">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.jobTypeId}
              onChange={(event) => setFilters({ ...filters, jobTypeId: event.target.value })}
            >
              <option value="">{t('operations.maintenance.allJobTypes')}</option>
              {options.jobTypes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.maintenance.statusLabel')} className="min-w-40">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.standing}
              onChange={(event) => setFilters({ ...filters, standing: event.target.value })}
            >
              <option value="">{t('operations.maintenance.allStatuses')}</option>
              {STANDINGS.map((standing) => (
                <option key={standing} value={standing}>
                  {t(`operations.maintenance.standing.${standing}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {reversed ? (
        <p className="text-sm text-danger">{t('operations.maintenance.rangeReversed')}</p>
      ) : null}
      {data === undefined ? null : (
        <p className="text-xs text-content-muted">
          {t('operations.maintenance.asOf', { today: formatCalendarDate(data.today, { locale }) })}
        </p>
      )}

      {list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : data === undefined ? (
        <Loading />
      ) : groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {data.items.length === 0
            ? t('operations.maintenance.empty')
            : t('operations.maintenance.noMatch')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('operations.maintenance.title')}</caption>
            <thead className="border-b border-border-subtle text-xs text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.maintenance.due')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.maintenance.planAndAsset')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.maintenance.customerAndSite')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.maintenance.statusLabel')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.maintenance.job')}
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.month} className="divide-y divide-border-subtle">
                <tr className="bg-surface-muted">
                  <th
                    scope="rowgroup"
                    colSpan={5}
                    className="px-3 py-1.5 text-start text-xs font-semibold text-content"
                  >
                    {formatMonth(group.month, locale)}
                  </th>
                </tr>
                {group.items.map((item) => (
                  <tr
                    key={item.key}
                    className={item.standing === 'overdue' ? 'bg-danger-subtle' : undefined}
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-content">
                      {formatCalendarDate(item.dueOn, { locale })}
                    </td>
                    <td className="px-3 py-2">
                      <span dir="auto" className="block text-content">
                        {item.plan.title}
                      </span>
                      <span className="text-xs">
                        {link(
                          paths.asset(item.asset.id),
                          <>
                            <span dir="ltr">{item.asset.reference}</span>{' '}
                            <span dir="auto">{item.asset.name}</span>
                          </>,
                        )}
                      </span>
                      <span dir="auto" className="block text-xs text-content-muted">
                        {item.jobType.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-content">
                      <span dir="auto">{item.customer.name}</span>
                      <span dir="auto" className="block text-xs text-content-muted">
                        {item.site.name}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <MaintenanceStandingBadge standing={item.standing} />
                      {item.skipReason === null ? null : (
                        <span className="block text-xs text-content-muted">
                          {t(`operations.maintenance.skip.${skipKey(item.skipReason)}`)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {item.workOrder === null ? (
                        <span className="text-content-muted">
                          {item.standing === 'upcoming' ? t('operations.maintenance.notYet') : '—'}
                        </span>
                      ) : (
                        link(
                          paths.workOrder(item.workOrder.id),
                          <span dir="ltr">{item.workOrder.reference}</span>,
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

/** A skip reason the screen has words for; anything newer reads as the plain one. */
function skipKey(reason: string): 'asset_retired' | 'contract_ended' | 'plan_ended' | 'other' {
  return reason === 'asset_retired' || reason === 'contract_ended' || reason === 'plan_ended'
    ? reason
    : 'other';
}
