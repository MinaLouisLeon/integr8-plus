import { ApiRequestError } from '@integr8/api-client';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type PayRunSummary, useOperations } from '../api.js';
import { Amount, AppLink, formatMonth } from '../ledger/ledger-parts.js';
import { buttonClass, cardClass, DashboardBackLink, Field, inputClass, Loading } from '../ui.js';
import {
  Disclaimer,
  disclaimerText,
  errorCode,
  localToday,
  Notice,
  PayrollFailure,
  RunStatusBadge,
  usePayrollAccess,
} from './payroll-parts.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

/**
 * The company's pay runs, latest month first (ADR-0010): each month's
 * status and totals, who prepared it and who approved it, and a way to
 * prepare the next one. Preparing needs a rule set the owner confirmed; when
 * there is none the refusal says so and leads to the rules.
 */
export function PayRunsScreen() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const access = usePayrollAccess();

  const runs = useInfiniteQuery({
    queryKey: keys.payRuns,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/payroll/runs', {
          params: { query: pageParam === '' ? {} : { before: pageParam } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: access.run,
  });
  const rows = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const serverDisclaimer = runs.data?.pages[0]?.disclaimer;

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('payroll.runs.title')}</h1>
        <p className="text-sm text-content-muted">{t('payroll.runs.intro')}</p>
      </div>
      {access.run ? (
        <AppLink to={paths.payrollRules} className="text-sm">
          {t('payroll.runs.rulesLink')}
        </AppLink>
      ) : null}
    </header>
  );

  if (access.loaded && !access.run) {
    return (
      <div className="flex flex-col gap-6 text-start">
        <DashboardBackLink />
        {header}
        <Notice>
          <p>{access.enabled ? t('payroll.runs.notAllowed') : t('errors.featureDisabled')}</p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      {header}
      <Disclaimer
        text={disclaimerText(
          serverDisclaimer ?? t('payroll.disclaimer'),
          locale,
          t('payroll.disclaimer'),
        )}
      />
      <PrepareRun runs={rows} />

      {runs.isPending ? (
        <Loading />
      ) : runs.isError ? (
        <PayrollFailure error={runs.error} onRetry={() => void runs.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">{t('payroll.runs.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
            <table className="w-full min-w-[48rem] text-sm">
              <caption className="sr-only">{t('payroll.runs.title')}</caption>
              <thead className="border-b border-border-subtle text-xs text-content-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('payroll.runs.month')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('payroll.runs.status')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    {t('payroll.runs.employees')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    {t('payroll.totals.gross')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    {t('payroll.totals.net')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('payroll.runs.who')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((run) => (
                  <tr key={run.id}>
                    <th scope="row" className="px-4 py-3 text-start font-normal">
                      <AppLink to={paths.payRun(run.id)} className="font-medium">
                        {formatMonth(run.periodStart, locale)}
                      </AppLink>
                      <span className="block text-xs text-content-muted" dir="ltr">
                        {run.reference}
                      </span>
                    </th>
                    <td className="px-4 py-3">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums">{run.totals.employees}</td>
                    <td className="px-4 py-3 text-end">
                      <Amount value={run.totals.gross} currency={run.currency} />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Amount value={run.totals.net} currency={run.currency} strong />
                    </td>
                    <td className="px-4 py-3 text-content-muted">
                      <span className="block">
                        {t('payroll.runs.preparedBy', {
                          name: run.preparedBy.name,
                          when: formatDateTime(run.preparedAt, { locale }),
                        })}
                      </span>
                      {run.approvedBy === null || run.approvedAt === null ? null : (
                        <span className="block">
                          {t('payroll.runs.approvedBy', {
                            name: run.approvedBy.name,
                            when: formatDateTime(run.approvedAt, { locale }),
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={runs.isFetchingNextPage}
              onClick={() => void runs.fetchNextPage()}
            >
              {t('payroll.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Prepares a month's run. The month this one by default; the server says
 * when it is too far ahead, already has a run, or has no confirmed rules.
 */
function PrepareRun({ runs }: { runs: readonly PayRunSummary[] }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const [month, setMonth] = useState(() => localToday().slice(0, 7));
  const [tried, setTried] = useState(false);
  const valid = MONTH.test(month);

  const prepare = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/payroll/runs', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { month },
        })
      ).data!,
    onSuccess: async (run) => {
      queries.setQueryData(keys.payRun(run.id), run);
      await queries.invalidateQueries({ queryKey: keys.payRuns });
      navigate(paths.payRun(run.id));
    },
  });
  const code = errorCode(prepare.error);
  // The refusal names the month's run; the list may not have it yet.
  const takenBy =
    code === 'month_taken' && prepare.error instanceof ApiRequestError
      ? prepare.error.details.find((detail) => detail.code === 'month_taken')?.params?.runId
      : undefined;
  const existing =
    code !== 'month_taken'
      ? undefined
      : (runs.find((run) => (takenBy ? run.id === takenBy : run.periodStart.startsWith(month))) ??
        (takenBy ? { id: takenBy, reference: null } : undefined));

  return (
    <form
      aria-labelledby="payroll-prepare"
      className={cardClass}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (valid) {
          prepare.mutate();
        }
      }}
    >
      <h2 id="payroll-prepare" className="text-base font-semibold text-content">
        {t('payroll.prepare.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('payroll.prepare.intro')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label={t('payroll.prepare.month')}
          hint={
            tried && !valid ? t('payroll.prepare.monthInvalid') : t('payroll.prepare.monthHint')
          }
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="month"
              dir="ltr"
              required
              aria-describedby={describedBy}
              aria-invalid={tried && !valid}
              className={inputClass}
              value={month}
              onChange={(event) => {
                prepare.reset();
                setMonth(event.target.value);
              }}
            />
          )}
        </Field>
        <button type="submit" className={buttonClass.primary} disabled={prepare.isPending}>
          {prepare.isPending ? t('payroll.prepare.preparing') : t('payroll.prepare.action')}
        </button>
      </div>
      {prepare.isError ? (
        <PayrollFailure error={prepare.error}>
          {code === 'no_confirmed_rules' || code === 'rules_not_confirmed' ? (
            <AppLink to={paths.payrollRules} className="text-sm">
              {t('payroll.prepare.toRules')}
            </AppLink>
          ) : null}
          {existing === undefined ? null : (
            <AppLink to={paths.payRun(existing.id)} className="text-sm">
              {existing.reference === null
                ? t('payroll.prepare.toExistingRun')
                : t('payroll.prepare.toExisting', { reference: existing.reference })}
            </AppLink>
          )}
        </PayrollFailure>
      ) : null}
    </form>
  );
}
