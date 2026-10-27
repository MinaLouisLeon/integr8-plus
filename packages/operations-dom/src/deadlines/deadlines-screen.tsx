import { toCsv } from '@integr8/core';
import {
  formatCalendarDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  useTranslation,
} from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { type DeadlineRules, type DeadlineSummary, keys, useOperations } from '../api.js';
import { termReversed } from '../contracts/model.js';
import {
  buttonClass,
  cardClass,
  DashboardBackLink,
  Failure,
  inputClass,
  Loading,
  PriorityBadge,
  useDuration,
} from '../ui.js';
import {
  joinMinutes,
  reportCsvRows,
  type RuleDraft,
  ruleDrafts,
  ruleProblem,
  rulesBody,
  share,
} from './model.js';

/**
 * Response deadlines (P27): how the company did against them over a period —
 * in total, per customer, and every miss — and the rules themselves, one per
 * priority. Anyone who sees every job reads both; owners and admins change
 * the rules. A miss is recorded when it happens, so the report is the record,
 * not a picture of today.
 */
export function DeadlinesScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('operations.deadlines.title')}</h1>
        <p className="text-sm text-content-muted">{t('operations.deadlines.intro')}</p>
      </header>
      <Report />
      <Rules />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function Report() {
  const { t } = useTranslation();
  const { client, locale, paths, navigate, download } = useOperations();
  const duration = useDuration();
  const [range, setRange] = useState<{ from: string; to: string } | undefined>();
  const [draft, setDraft] = useState<{ from: string; to: string } | undefined>();

  const query = range ?? {};
  const report = useQuery({
    queryKey: keys.deadlineReport(query),
    queryFn: async () => (await client.GET('/v1/deadline-report', { params: { query } })).data!,
    placeholderData: (previous) => previous,
  });
  const data = report.data;
  const from = draft?.from ?? data?.from ?? '';
  const to = draft?.to ?? data?.to ?? '';
  const reversed = termReversed(from, to);

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

  const percentOf = (part: number, whole: number) => {
    const value = share(part, whole);
    return value === null ? '—' : formatPercent(value, { locale });
  };
  const average = (summary: DeadlineSummary) =>
    summary.averageResponseMinutes === null
      ? '—'
      : duration(summary.averageResponseMinutes * 60_000);

  const downloadCsv = () => {
    if (data === undefined) {
      return;
    }
    const rows = reportCsvRows(data, {
      customer: t('operations.deadlines.report.customer'),
      jobs: t('operations.deadlines.report.jobs'),
      responseDue: t('operations.deadlines.csv.responseDue'),
      respondedOnTime: t('operations.deadlines.report.respondedOnTime'),
      responseShare: t('operations.deadlines.csv.responseShare'),
      completionDue: t('operations.deadlines.csv.completionDue'),
      completedOnTime: t('operations.deadlines.report.completedOnTime'),
      completionShare: t('operations.deadlines.csv.completionShare'),
      averageResponse: t('operations.deadlines.csv.averageResponse'),
      missed: t('operations.deadlines.report.missed'),
      totals: t('operations.deadlines.report.totals'),
      job: t('operations.deadlines.report.job'),
      title: t('operations.deadlines.csv.title'),
      deadline: t('operations.deadlines.report.deadline'),
      priority: t('operations.priority.label'),
      dueAt: t('operations.deadlines.report.dueAt'),
      metAt: t('operations.deadlines.report.metAt'),
      recordedAt: t('operations.deadlines.csv.recordedAt'),
      kind: (kind) => t(`operations.deadlines.kind.${kind}`),
      priorityName: (priority) => t(`operations.priority.${priority}`),
    });
    download(
      new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
      `response-deadlines-${data.from}-to-${data.to}.csv`,
    );
  };

  return (
    <section aria-labelledby="deadline-report-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="deadline-report-heading" className="text-lg font-semibold text-content">
          {t('operations.deadlines.report.title')}
        </h2>
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={data === undefined}
          onClick={downloadCsv}
        >
          {t('operations.deadlines.report.download')}
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="deadline-report-from" className="text-sm font-medium text-content">
            {t('operations.deadlines.report.from')}
          </label>
          <input
            id="deadline-report-from"
            type="date"
            className={inputClass}
            value={from}
            aria-invalid={reversed}
            onChange={(event) => setDay('from', event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="deadline-report-to" className="text-sm font-medium text-content">
            {t('operations.deadlines.report.to')}
          </label>
          <input
            id="deadline-report-to"
            type="date"
            className={inputClass}
            value={to}
            aria-invalid={reversed}
            onChange={(event) => setDay('to', event.target.value)}
          />
        </div>
      </div>
      {reversed ? (
        <p className="text-sm text-danger">{t('operations.deadlines.report.rangeReversed')}</p>
      ) : null}

      {report.isError ? (
        <Failure error={report.error} onRetry={() => void report.refetch()} />
      ) : data === undefined ? (
        <Loading />
      ) : (
        <>
          <p className="text-xs text-content-muted">
            {t('operations.deadlines.report.period', {
              from: formatCalendarDate(data.from, { locale }),
              to: formatCalendarDate(data.to, { locale }),
            })}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {(
              [
                ['jobs', formatNumber(data.totals.jobs, { locale })],
                [
                  'respondedOnTime',
                  percentOf(data.totals.respondedOnTime, data.totals.responseDue),
                ],
                [
                  'completedOnTime',
                  percentOf(data.totals.completedOnTime, data.totals.completionDue),
                ],
                ['averageResponse', average(data.totals)],
                ['missed', formatNumber(data.totals.missed, { locale })],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className={cardClass}>
                <dt className="text-xs text-content-muted">
                  {t(`operations.deadlines.report.${key}`)}
                </dt>
                <dd className="text-2xl font-semibold text-content">{value}</dd>
              </div>
            ))}
          </dl>

          {data.customers.length === 0 ? (
            <p className="py-6 text-center text-sm text-content-muted">
              {t('operations.deadlines.report.empty')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('operations.deadlines.report.byCustomer')}</caption>
                <thead className="border-b border-border-subtle text-xs text-content-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('operations.deadlines.report.customer')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('operations.deadlines.report.jobs')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('operations.deadlines.report.respondedOnTime')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('operations.deadlines.report.completedOnTime')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('operations.deadlines.report.averageResponse')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('operations.deadlines.report.missed')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.customers.map(({ customer, summary }) => (
                    <tr key={customer.id}>
                      <th
                        scope="row"
                        dir="auto"
                        className="px-3 py-2 text-start font-normal text-content"
                      >
                        {customer.name}
                      </th>
                      <td className="px-3 py-2 text-end text-content">
                        {formatNumber(summary.jobs, { locale })}
                      </td>
                      <td className="px-3 py-2 text-end text-content">
                        {percentOf(summary.respondedOnTime, summary.responseDue)}
                      </td>
                      <td className="px-3 py-2 text-end text-content">
                        {percentOf(summary.completedOnTime, summary.completionDue)}
                      </td>
                      <td className="px-3 py-2 text-end text-content">{average(summary)}</td>
                      <td
                        className={`px-3 py-2 text-end ${summary.missed > 0 ? 'font-semibold text-danger' : 'text-content'}`}
                      >
                        {formatNumber(summary.missed, { locale })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="text-base font-semibold text-content">
            {t('operations.deadlines.report.misses')}
          </h3>
          {data.misses.length === 0 ? (
            <p className="text-sm text-content-muted">
              {t('operations.deadlines.report.noMisses')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('operations.deadlines.report.misses')}</caption>
                <thead className="border-b border-border-subtle text-xs text-content-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('operations.deadlines.report.job')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('operations.deadlines.report.customer')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('operations.deadlines.report.deadline')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('operations.deadlines.report.dueAt')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('operations.deadlines.report.metAt')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.misses.map((miss) => (
                    <tr key={`${miss.workOrder.id}-${miss.kind}`}>
                      <td className="px-3 py-2">
                        <a
                          href={paths.workOrder(miss.workOrder.id)}
                          className="text-accent underline-offset-4 hover:underline"
                          onClick={(event) => {
                            event.preventDefault();
                            navigate(paths.workOrder(miss.workOrder.id));
                          }}
                        >
                          <span dir="ltr">{miss.workOrder.reference}</span> ·{' '}
                          <span dir="auto">{miss.workOrder.title}</span>
                        </a>
                      </td>
                      <td dir="auto" className="px-3 py-2 text-content">
                        {miss.customer.name}
                      </td>
                      <td className="px-3 py-2 text-content">
                        <span className="flex flex-wrap items-center gap-2">
                          {t(`operations.deadlines.kind.${miss.kind}`)}
                          <PriorityBadge priority={miss.priority} />
                        </span>
                      </td>
                      <td className="px-3 py-2 text-content">
                        {formatDateTime(miss.dueAt, { locale })}
                      </td>
                      <td className="px-3 py-2 text-content">
                        {miss.metAt === null
                          ? t('operations.deadlines.report.notMet')
                          : formatDateTime(miss.metAt, { locale })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

function Rules() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const rules = useQuery({
    queryKey: keys.deadlineRules,
    queryFn: async () => (await client.GET('/v1/deadline-rules')).data!,
  });

  return (
    <section aria-labelledby="deadline-rules-heading" className={cardClass}>
      <h2 id="deadline-rules-heading" className="text-lg font-semibold text-content">
        {t('operations.deadlines.rules.title')}
      </h2>
      {rules.isError ? (
        <Failure error={rules.error} onRetry={() => void rules.refetch()} />
      ) : rules.data === undefined ? (
        <Loading />
      ) : (
        <RulesForm data={rules.data} />
      )}
    </section>
  );
}

function workingHoursText(
  hours: DeadlineRules['workingHours'],
  locale: string,
): {
  from: string;
  to: string;
  days: string;
} {
  const clock = (minute: number) =>
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 1, Math.floor(minute / 60), minute % 60)),
    );
  // 5 January 2026 was a Monday: ISO weekday 1.
  const weekday = (day: number) =>
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 4 + day)),
    );
  return {
    from: clock(hours.startsMinute),
    to: clock(hours.endsMinute),
    days: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
      [...hours.days].sort((a, b) => a - b).map(weekday),
    ),
  };
}

function RulesForm({ data }: { data: DeadlineRules }) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const duration = useDuration();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<RuleDraft[]>(() =>
    ruleDrafts(data.rules, data.defaults.warnMinutes),
  );
  const manage = data.can.manage;
  const problems = drafts.map(ruleProblem);
  const ready = problems.every((problem) => problem === undefined);

  const save = useMutation({
    mutationFn: async () =>
      (await client.PUT('/v1/deadline-rules', { body: { rules: rulesBody(drafts) } })).data!,
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.deadlineRules, saved);
    },
  });

  const change = (index: number, patch: Partial<RuleDraft>) =>
    setDrafts((current) =>
      current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)),
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (manage && ready && !save.isPending) {
      save.mutate();
    }
  };
  const hours = workingHoursText(data.workingHours, locale);
  const minutesText = (value: number | null | undefined) =>
    value === null || value === undefined
      ? t('operations.deadlines.rules.none')
      : duration(value * 60_000);

  const box = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    invalid: boolean,
    max?: number,
  ) => (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      step={1}
      aria-label={label}
      aria-invalid={invalid}
      className={`${inputClass} w-20`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-content-muted">
        {manage ? t('operations.deadlines.rules.intro') : t('operations.deadlines.rules.readOnly')}
      </p>
      <p className="text-xs text-content-muted">
        {t('operations.deadlines.rules.workingHours', {
          from: hours.from,
          to: hours.to,
          days: hours.days,
          timeZone: data.workingHours.timeZone,
        })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('operations.deadlines.rules.title')}</caption>
          <thead className="border-b border-border-subtle text-xs text-content-muted">
            <tr>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('operations.priority.label')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('operations.deadlines.rules.respondWithin')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('operations.deadlines.rules.completeWithin')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('operations.deadlines.rules.clock')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('operations.deadlines.rules.warnMinutes')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {drafts.map((draft, index) => {
              const priority = t(`operations.priority.${draft.priority}`);
              const problem = problems[index];
              const response = joinMinutes(draft.responseHours, draft.responseMinutes);
              const completion = joinMinutes(draft.completionHours, draft.completionMinutes);
              const blank = response === null && completion === null;
              return (
                <tr key={draft.priority} className="align-top">
                  <th scope="row" className="px-2 py-2 text-start font-normal">
                    <PriorityBadge priority={draft.priority} />
                    {problem === undefined ? null : (
                      <span role="alert" className="mt-1 block text-xs text-danger">
                        {t(`operations.deadlines.rules.problem.${problem}`)}
                      </span>
                    )}
                  </th>
                  <td className="px-2 py-2">
                    {manage ? (
                      <span className="flex items-center gap-1">
                        {box(
                          t('operations.deadlines.rules.hoursFor', {
                            what: t('operations.deadlines.kind.response'),
                            priority,
                          }),
                          draft.responseHours,
                          (value) => change(index, { responseHours: value }),
                          response === undefined,
                        )}
                        <span className="text-xs text-content-muted">
                          {t('operations.deadlines.rules.h')}
                        </span>
                        {box(
                          t('operations.deadlines.rules.minutesFor', {
                            what: t('operations.deadlines.kind.response'),
                            priority,
                          }),
                          draft.responseMinutes,
                          (value) => change(index, { responseMinutes: value }),
                          response === undefined,
                          59,
                        )}
                        <span className="text-xs text-content-muted">
                          {t('operations.deadlines.rules.min')}
                        </span>
                      </span>
                    ) : (
                      minutesText(response)
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {manage ? (
                      <span className="flex items-center gap-1">
                        {box(
                          t('operations.deadlines.rules.hoursFor', {
                            what: t('operations.deadlines.kind.completion'),
                            priority,
                          }),
                          draft.completionHours,
                          (value) => change(index, { completionHours: value }),
                          completion === undefined,
                        )}
                        <span className="text-xs text-content-muted">
                          {t('operations.deadlines.rules.h')}
                        </span>
                        {box(
                          t('operations.deadlines.rules.minutesFor', {
                            what: t('operations.deadlines.kind.completion'),
                            priority,
                          }),
                          draft.completionMinutes,
                          (value) => change(index, { completionMinutes: value }),
                          completion === undefined,
                          59,
                        )}
                        <span className="text-xs text-content-muted">
                          {t('operations.deadlines.rules.min')}
                        </span>
                      </span>
                    ) : (
                      minutesText(completion)
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {manage ? (
                      <select
                        aria-label={t('operations.deadlines.rules.clockFor', { priority })}
                        className={inputClass}
                        value={draft.clock}
                        onChange={(event) =>
                          change(index, { clock: event.target.value as RuleDraft['clock'] })
                        }
                      >
                        <option value="always">{t('operations.deadlines.rules.always')}</option>
                        <option value="working_hours">
                          {t('operations.deadlines.rules.working_hours')}
                        </option>
                      </select>
                    ) : blank ? (
                      '—'
                    ) : (
                      t(`operations.deadlines.rules.${draft.clock}`)
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {manage
                      ? box(
                          t('operations.deadlines.rules.warnFor', { priority }),
                          draft.warnMinutes,
                          (value) => change(index, { warnMinutes: value }),
                          problem === 'warnInvalid',
                        )
                      : blank
                        ? '—'
                        : duration(Number(draft.warnMinutes) * 60_000)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-content-muted">{t('operations.deadlines.rules.hint')}</p>
      {manage ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={!ready || save.isPending}
            aria-busy={save.isPending}
          >
            {t('operations.deadlines.rules.save')}
          </button>
          {save.isSuccess ? (
            <span role="status" className="text-sm text-content-muted">
              {t('operations.common.saved')}
            </span>
          ) : null}
        </div>
      ) : null}
      {save.isError ? <Failure error={save.error} /> : null}
    </form>
  );
}
