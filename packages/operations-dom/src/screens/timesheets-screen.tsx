import { formatDate, formatDateTime, formatTime, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { keys, useOperations } from '../api.js';
import {
  addDays,
  dayKey,
  parseDayKey,
  startOfWeek,
  summarizeTimesheet,
  type TimesheetDay,
  type TimesheetPerson,
  type Totals,
} from '../timesheets.js';
import {
  buttonClass,
  cardClass,
  copyText,
  DashboardBackLink,
  Failure,
  Field,
  InlineError,
  inputClass,
  Loading,
  useDuration,
  useRowMenu,
} from '../ui.js';

/**
 * Who worked when, a week at a time: each person's shifts, and the time they
 * spent travelling to, on site at and working on each job, with totals for
 * every day and the week.
 *
 * The office can look at anyone, or everyone; anybody else sees only their own
 * time, which is all the server returns them.
 */
export function TimesheetsScreen() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [userId, setUserId] = useState('');

  const from = week;
  const to = addDays(week, 7);
  const query = { from: from.toISOString(), to: to.toISOString(), userId };

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const office = me.data?.permissions.includes('work_order.manage') ?? false;
  const members = useQuery({
    queryKey: keys.members,
    queryFn: async () =>
      (await client.GET('/v1/members', { params: { query: { limit: 200 } } })).data!.items,
    enabled: office,
  });
  const sheet = useQuery({
    queryKey: keys.timesheet(query),
    queryFn: async () =>
      (
        await client.GET('/v1/timesheets', {
          params: {
            query: {
              from: query.from,
              to: query.to,
              ...(userId === '' ? {} : { userId }),
            },
          },
        })
      ).data!,
  });

  const summary = useMemo(
    () =>
      sheet.data === undefined
        ? []
        : summarizeTimesheet(
            sheet.data,
            { from: new Date(query.from), to: new Date(query.to) },
            new Date(),
          ),
    [sheet.data, query.from, query.to],
  );
  const thisWeek = dayKey(startOfWeek(new Date()));

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('operations.timesheets.title')}</h1>
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setWeek(addDays(week, -7))}
          >
            {t('operations.timesheets.previousWeek')}
          </button>
          <Field label={t('operations.timesheets.week')}>
            {(id) => (
              <input
                id={id}
                type="date"
                className={inputClass}
                value={dayKey(week)}
                onChange={(event) => {
                  const picked = parseDayKey(event.target.value);
                  if (picked !== undefined) {
                    setWeek(startOfWeek(picked));
                  }
                }}
              />
            )}
          </Field>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setWeek(addDays(week, 7))}
          >
            {t('operations.timesheets.nextWeek')}
          </button>
          <button
            type="button"
            className={buttonClass.ghost}
            disabled={dayKey(week) === thisWeek}
            onClick={() => setWeek(startOfWeek(new Date()))}
          >
            {t('operations.timesheets.thisWeek')}
          </button>
          {office ? (
            <Field label={t('operations.timesheets.person')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                >
                  <option value="">{t('operations.timesheets.everyone')}</option>
                  {(members.data ?? [])
                    .filter((member) => member.status === 'active')
                    .map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          ) : null}
        </div>
        {me.isError ? <InlineError onRetry={() => void me.refetch()} /> : null}
        {members.isError ? <InlineError onRetry={() => void members.refetch()} /> : null}
        <p className="text-sm text-content-muted">
          {t('operations.timesheets.range', {
            from: formatDate(from, { locale }),
            to: formatDate(addDays(week, 6), { locale }),
          })}
        </p>
      </header>

      {sheet.data?.truncated === true ? (
        <p role="status" className="text-sm text-content-muted">
          {t('operations.timesheets.truncated')}
        </p>
      ) : null}
      {sheet.isPending ? (
        <Loading />
      ) : sheet.isError ? (
        <Failure error={sheet.error} onRetry={() => void sheet.refetch()} />
      ) : summary.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('operations.timesheets.empty')}
        </p>
      ) : (
        summary.map((entry) => <PersonSheet key={entry.person.id} entry={entry} />)
      )}
    </div>
  );
}

function PersonSheet({ entry }: { entry: TimesheetPerson }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cardClass}>
      <h2 id={headingId} className="text-lg font-semibold text-content">
        {entry.person.name}
      </h2>
      <TotalsGroup label={t('operations.timesheets.weekTotal')} totals={entry.totals} />
      <ol className="flex flex-col divide-y divide-border-subtle">
        {entry.days.map((day) => (
          <li key={dayKey(day.day)} className="flex flex-col gap-3 py-3">
            <Day day={day} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Day({ day }: { day: TimesheetDay }) {
  const { t } = useTranslation();
  const { locale, navigate, paths } = useOperations();
  const duration = useDuration();
  const rowMenu = useRowMenu();
  const date = formatDate(day.day, { locale });
  const sameDay = (value: string) => dayKey(new Date(value)) === dayKey(day.day);
  const clock = (value: string) =>
    sameDay(value) ? formatTime(value, { locale }) : formatDateTime(value, { locale });

  return (
    <>
      <h3 className="text-base font-semibold text-content">{date}</h3>

      {day.shifts.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.timesheets.noShifts')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {day.shifts.map((shift) => {
            const label =
              shift.endedAt === null
                ? t('operations.timesheets.shiftOpen', { start: clock(shift.startedAt) })
                : t('operations.timesheets.shift', {
                    start: clock(shift.startedAt),
                    end: clock(shift.endedAt),
                  });
            return (
              <li
                key={shift.id}
                className="flex flex-wrap items-center gap-2 text-content"
                onContextMenu={rowMenu({ kind: 'timesheetShift', id: shift.id, label }, () => [
                  {
                    key: 'copyId',
                    label: t('operations.rowActions.copyId'),
                    onSelect: () => copyText(shift.id),
                  },
                ])}
              >
                <span>{label}</span>
                {shift.endedAt === null ? (
                  <span className="rounded-full border border-accent px-2 text-xs text-content">
                    {t('operations.timesheets.clockedIn')}
                  </span>
                ) : null}
                <span className="text-content-muted">{duration(shift.durationMs)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {day.jobs.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.timesheets.noJobs')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border-subtle">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('operations.timesheets.jobs', { day: date })}</caption>
            <thead className="bg-surface-muted text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.timesheets.job')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.timesheets.travel')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.timesheets.onSite')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.timesheets.working')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {day.jobs.map((job) => (
                <tr
                  key={job.workOrderId}
                  onContextMenu={rowMenu(
                    {
                      kind: 'workOrder',
                      id: job.workOrderId,
                      label: `${job.referenceLabel} · ${job.title}`,
                    },
                    () => [
                      {
                        key: 'open',
                        label: t('operations.rowActions.open'),
                        onSelect: () => navigate(paths.workOrder(job.workOrderId)),
                      },
                      {
                        key: 'copyId',
                        label: t('operations.rowActions.copyId'),
                        onSelect: () => copyText(job.workOrderId),
                      },
                    ],
                  )}
                >
                  <th scope="row" className="px-3 py-2 text-start font-normal">
                    <a
                      href={paths.workOrder(job.workOrderId)}
                      className="text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.workOrder(job.workOrderId));
                      }}
                    >
                      <span className="font-mono">{job.referenceLabel}</span>{' '}
                      <span dir="auto">{job.title}</span>
                    </a>
                  </th>
                  <td className="px-3 py-2 text-content">{duration(job.travelMs)}</td>
                  <td className="px-3 py-2 text-content">{duration(job.onSiteMs)}</td>
                  <td className="px-3 py-2 text-content">{duration(job.workMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TotalsGroup label={t('operations.timesheets.dayTotal')} totals={day.totals} />
    </>
  );
}

/** Shift time, travel, on site and working, as one labelled group. */
function TotalsGroup({ label, totals }: { label: string; totals: Totals }) {
  const { t } = useTranslation();
  const duration = useDuration();
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1">
      <p id={labelId} className="text-sm font-medium text-content">
        {label}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Total label={t('operations.timesheets.shiftTime')}>{duration(totals.shiftMs)}</Total>
        <Total label={t('operations.timesheets.travel')}>{duration(totals.travelMs)}</Total>
        <Total label={t('operations.timesheets.onSite')}>{duration(totals.onSiteMs)}</Total>
        <Total label={t('operations.timesheets.working')}>{duration(totals.workMs)}</Total>
      </dl>
    </div>
  );
}

function Total({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content">{children}</dd>
    </div>
  );
}
