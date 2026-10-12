import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type Employee, keys, useOperations } from '../api.js';
import { AppLink } from '../ledger/ledger-parts.js';
import { buttonClass, DashboardBackLink, Field, inputClass, Loading, useRowMenu } from '../ui.js';
import { EmployeeStatusBadge, HrFailure, SEALED_FIELDS, useHrAccess } from './hr-parts.js';

interface Filters {
  q: string;
  status: 'active' | 'ended' | 'all';
  department: string;
}

const NO_FILTERS: Filters = { q: '', status: 'active', department: '' };

/**
 * Everybody the company employs, by name (ADR-0010): those still here unless
 * asked otherwise, found by name, number, title or department. Owners and HR
 * managers see the last four of each ID and bank number; nobody sees more
 * here. Those who manage HR add people from here.
 */
export function EmployeeListScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const access = useHrAccess();
  const rowMenu = useRowMenu();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);

  const query = {
    status: applied.status,
    ...(applied.q === '' ? {} : { q: applied.q }),
    ...(applied.department === '' ? {} : { department: applied.department }),
    limit: 50,
  };
  const employees = useInfiniteQuery({
    queryKey: keys.employees(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/hr/employees', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = employees.data?.pages.flatMap((page) => page.items) ?? [];
  const departments = employees.data?.pages[0]?.departments ?? [];
  const filtered = JSON.stringify(applied) !== JSON.stringify(NO_FILTERS);
  const set = (change: Partial<Filters>) => setDraft({ ...draft, ...change });

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('hr.list.title')}</h1>
          <p className="text-sm text-content-muted">{t('hr.list.intro')}</p>
        </div>
        {access.manage ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => navigate(paths.newEmployee)}
          >
            {t('hr.list.add')}
          </button>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ ...draft, q: draft.q.trim() });
        }}
      >
        <Field
          label={t('hr.list.search')}
          hint={t('hr.list.searchHint')}
          className="min-w-56 flex-1"
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="search"
              dir="auto"
              maxLength={200}
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.q}
              onChange={(event) => set({ q: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('hr.list.status')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.status}
              onChange={(event) => set({ status: event.target.value as Filters['status'] })}
            >
              <option value="active">{t('hr.status.active')}</option>
              <option value="ended">{t('hr.status.ended')}</option>
              <option value="all">{t('hr.list.statusAll')}</option>
            </select>
          )}
        </Field>
        <Field label={t('hr.list.department')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.department}
              onChange={(event) => set({ department: event.target.value })}
            >
              <option value="">{t('hr.list.anyDepartment')}</option>
              {departments.map((department) => (
                <option key={department} value={department}>
                  {department}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('hr.apply')}
        </button>
      </form>

      {employees.isPending ? (
        <Loading />
      ) : employees.isError ? (
        <HrFailure error={employees.error} onRetry={() => void employees.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('hr.list.empty') : t('hr.list.emptyAll')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((employee) => (
              <li
                key={employee.id}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'employee', id: employee.id, label: employee.fullName },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.employee(employee.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <AppLink to={paths.employee(employee.id)} className="font-medium">
                      <span dir="auto">{employee.fullName}</span>
                    </AppLink>
                    <EmployeeStatusBadge status={employee.status} />
                    {employee.employeeNumber === null ? null : (
                      <span className="text-sm text-content-muted">
                        {t('hr.list.number', { number: employee.employeeNumber })}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-sm text-content-muted" dir="auto">
                    {[employee.jobTitle, employee.department]
                      .filter((part): part is string => part !== null && part !== '')
                      .join(' · ')}
                  </span>
                  <MaskedNumbers employee={employee} />
                </div>
                <div className="flex flex-col items-end gap-0.5 text-sm text-content-muted">
                  <span>
                    {employee.endDate === null
                      ? t('hr.list.since', {
                          date: formatCalendarDate(employee.hireDate, { locale }),
                        })
                      : t('hr.list.leftOn', {
                          date: formatCalendarDate(employee.endDate, { locale }),
                        })}
                  </span>
                  {employee.member === null ? <span>{t('hr.list.noSignIn')}</span> : null}
                </div>
              </li>
            ))}
          </ul>
          {employees.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={employees.isFetchingNextPage}
              onClick={() => void employees.fetchNextPage()}
            >
              {t('hr.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The last four of each ID and bank number, where this seat may see them at all. */
function MaskedNumbers({ employee }: { employee: Employee }) {
  const { t } = useTranslation();
  const sensitive = employee.sensitive;
  if (sensitive === null) {
    return null;
  }
  const shown = SEALED_FIELDS.flatMap((field) => {
    const masked = sensitive[field];
    return masked === null ? [] : [{ field, last4: masked.last4 }];
  });
  if (shown.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-content-muted">
      {shown.map(({ field, last4 }) => (
        <span key={field}>{t('hr.list.masked', { field: t(`hr.field.${field}`), last4 })}</span>
      ))}
    </span>
  );
}
