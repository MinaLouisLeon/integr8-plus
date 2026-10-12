import { fiscalYearOf, toCsv } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type LedgerOverview, useOperations } from '../api.js';
import { BackLink, buttonClass, Field, inputClass, Loading } from '../ui.js';
import {
  AccountSelect,
  accountLabel,
  AppLink,
  LedgerFailure,
  ManagementNote,
  Notice,
  useLedgerAccounts,
  useLedgerOverview,
} from './ledger-parts.js';
import {
  activityCsv,
  ActivityView,
  balanceSheetCsv,
  BalanceSheetView,
  type CsvRow,
  profitAndLossCsv,
  ProfitAndLossView,
  receivablesCsv,
  ReceivablesView,
  trialBalanceCsv,
  TrialBalanceView,
} from './report-views.js';

export const LEDGER_REPORTS = [
  'trialBalance',
  'accountActivity',
  'receivables',
  'profitAndLoss',
  'balanceSheet',
] as const;
export type LedgerReport = (typeof LEDGER_REPORTS)[number];

const RANGED: ReadonlySet<LedgerReport> = new Set(['accountActivity', 'profitAndLoss']);
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const FILE_NAMES: Record<LedgerReport, string> = {
  trialBalance: 'trial-balance',
  accountActivity: 'account-activity',
  receivables: 'receivables',
  profitAndLoss: 'profit-and-loss',
  balanceSheet: 'balance-sheet',
};

/** The fiscal year to date: where a range report starts, never before the ledger does. */
function yearToDate(overview: LedgerOverview): { from: string; to: string } {
  const settings = overview.settings;
  if (settings === null) {
    return { from: overview.today, to: overview.today };
  }
  const start = fiscalYearOf(overview.today, settings.fiscalStartMonth).start;
  return {
    from: start < settings.startDate ? settings.startDate : start,
    to: overview.today,
  };
}

/**
 * The ledger's reports (ADR-0009): a trial balance at a date, one account's
 * activity over a range, receivables reconciled and aged, and a profit and
 * loss and balance sheet labelled as management reports. Each counts posted
 * journals only and says what it leaves out; each prints from the browser
 * and downloads as CSV.
 */
export function LedgerReportsScreen({
  initialReport = 'trialBalance',
}: {
  initialReport?: LedgerReport;
}) {
  const { t } = useTranslation();
  const { client, paths, locale, download } = useOperations();
  const overview = useLedgerOverview();
  const [report, setReport] = useState<LedgerReport>(initialReport);
  const [date, setDate] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const accounts = useLedgerAccounts(true, report === 'accountActivity');

  const ready = overview.data?.setUp === true;
  const defaults =
    overview.data === undefined
      ? undefined
      : { date: overview.data.today, ...yearToDate(overview.data) };
  const at = date ?? defaults?.date ?? '';
  const range = { from: from ?? defaults?.from ?? '', to: to ?? defaults?.to ?? '' };
  const dateValid = DATE.test(at);
  const rangeValid = DATE.test(range.from) && DATE.test(range.to) && range.from <= range.to;

  const trial = useQuery({
    queryKey: keys.ledgerReport('trialBalance', { date: at }),
    queryFn: async () =>
      (await client.GET('/v1/ledger/reports/trial-balance', { params: { query: { date: at } } }))
        .data!,
    enabled: ready && report === 'trialBalance' && dateValid,
  });
  const activity = useQuery({
    queryKey: keys.ledgerReport('accountActivity', { accountId, ...range }),
    queryFn: async () =>
      (
        await client.GET('/v1/ledger/reports/account-activity', {
          params: { query: { accountId, ...range } },
        })
      ).data!,
    enabled: ready && report === 'accountActivity' && rangeValid && accountId !== '',
  });
  const receivables = useQuery({
    queryKey: keys.ledgerReport('receivables', { date: at }),
    queryFn: async () =>
      (await client.GET('/v1/ledger/reports/receivables', { params: { query: { date: at } } }))
        .data!,
    enabled: ready && report === 'receivables' && dateValid,
  });
  const profit = useQuery({
    queryKey: keys.ledgerReport('profitAndLoss', range),
    queryFn: async () =>
      (await client.GET('/v1/ledger/reports/profit-and-loss', { params: { query: range } })).data!,
    enabled: ready && report === 'profitAndLoss' && rangeValid,
  });
  const balance = useQuery({
    queryKey: keys.ledgerReport('balanceSheet', { date: at }),
    queryFn: async () =>
      (await client.GET('/v1/ledger/reports/balance-sheet', { params: { query: { date: at } } }))
        .data!,
    enabled: ready && report === 'balanceSheet' && dateValid,
  });

  const current = {
    trialBalance: trial,
    accountActivity: activity,
    receivables,
    profitAndLoss: profit,
    balanceSheet: balance,
  }[report];
  const currency = overview.data?.currency ?? '';
  const ranged = RANGED.has(report);

  /** The report on screen as CSV rows, or nothing while it is not loaded. */
  const csvRows = (): CsvRow[] | undefined => {
    switch (report) {
      case 'trialBalance':
        return trial.data === undefined ? undefined : trialBalanceCsv(trial.data, t);
      case 'accountActivity':
        return activity.data === undefined ? undefined : activityCsv(activity.data, t);
      case 'receivables':
        return receivables.data === undefined ? undefined : receivablesCsv(receivables.data, t);
      case 'profitAndLoss':
        return profit.data === undefined ? undefined : profitAndLossCsv(profit.data, t);
      case 'balanceSheet':
        return balance.data === undefined ? undefined : balanceSheetCsv(balance.data, t);
    }
  };
  const downloadCsv = () => {
    const rows = csvRows();
    if (rows === undefined) {
      return;
    }
    const code =
      report === 'accountActivity' && activity.data !== undefined
        ? `-${activity.data.account.code}`
        : '';
    const period = ranged ? `${range.from}-to-${range.to}` : at;
    download(
      new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
      `${FILE_NAMES[report]}${code}-${period}.csv`,
    );
  };

  const leftOut = current.data?.leftOut;
  const period = ranged
    ? t('ledger.reports.rangeLine', {
        from: rangeValid ? formatCalendarDate(range.from, { locale }) : range.from,
        to: rangeValid ? formatCalendarDate(range.to, { locale }) : range.to,
      })
    : t('ledger.reports.atLine', {
        date: dateValid ? formatCalendarDate(at, { locale }) : at,
      });
  const statement = report === 'profitAndLoss' || report === 'balanceSheet';

  return (
    <div className="flex flex-col gap-6 text-start">
      <div className="print:hidden">
        <BackLink to={paths.ledger} label={t('ledger.back')} />
      </div>
      <header className="flex flex-col gap-2 print:hidden">
        <h1 className="text-2xl font-semibold text-content">{t('ledger.reports.title')}</h1>
        <ManagementNote />
      </header>

      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <LedgerFailure error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !overview.data.setUp ? (
        <Notice>
          <p>{t('ledger.home.notSetUp')}</p>
        </Notice>
      ) : (
        <>
          <form
            className="flex flex-wrap items-end gap-3 print:hidden"
            onSubmit={(event) => event.preventDefault()}
          >
            <Field label={t('ledger.reports.report')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={report}
                  onChange={(event) => setReport(event.target.value as LedgerReport)}
                >
                  {LEDGER_REPORTS.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {t(`ledger.reports.${candidate}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {report === 'accountActivity' ? (
              <Field label={t('ledger.reports.account')} className="min-w-64">
                {(id) =>
                  accounts.isError ? (
                    <LedgerFailure error={accounts.error} onRetry={() => void accounts.refetch()} />
                  ) : (
                    <AccountSelect
                      id={id}
                      accounts={accounts.data ?? []}
                      value={accountId}
                      onChange={setAccountId}
                    />
                  )
                }
              </Field>
            ) : null}
            {ranged ? (
              <>
                <Field label={t('ledger.reports.from')}>
                  {(id) => (
                    <input
                      id={id}
                      type="date"
                      dir="ltr"
                      required
                      className={inputClass}
                      value={range.from}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('ledger.reports.to')}>
                  {(id) => (
                    <input
                      id={id}
                      type="date"
                      dir="ltr"
                      required
                      className={inputClass}
                      value={range.to}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  )}
                </Field>
              </>
            ) : (
              <Field label={t('ledger.reports.asAt')}>
                {(id) => (
                  <input
                    id={id}
                    type="date"
                    dir="ltr"
                    required
                    className={inputClass}
                    value={at}
                    onChange={(event) => setDate(event.target.value)}
                  />
                )}
              </Field>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={current.data === undefined}
                onClick={downloadCsv}
              >
                {t('ledger.reports.downloadCsv')}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={current.data === undefined}
                onClick={() => window.print()}
              >
                {t('ledger.reports.print')}
              </button>
            </div>
          </form>

          <section aria-labelledby="ledger-report" className="flex flex-col gap-4">
            <header className="flex flex-col gap-1">
              <h2 id="ledger-report" className="text-xl font-semibold text-content">
                {t(`ledger.reports.${report}`)}
                {report === 'accountActivity' && activity.data !== undefined ? (
                  <span className="ms-2 font-normal">{accountLabel(activity.data.account)}</span>
                ) : null}
              </h2>
              <p className="text-sm text-content-muted">{period}</p>
              {statement ? (
                <p className="text-sm font-medium text-content">
                  {t('ledger.reports.managementReport')}
                </p>
              ) : (
                <ManagementNote className="hidden print:block" />
              )}
            </header>

            {ranged && !rangeValid && range.from !== '' && range.to !== '' ? (
              <p role="alert" className="text-sm text-content">
                {t('ledger.reports.rangeReversed')}
              </p>
            ) : null}
            {report === 'accountActivity' && accountId === '' ? (
              <p className="text-sm text-content-muted">{t('ledger.reports.chooseAccount')}</p>
            ) : null}

            {leftOut !== undefined && (leftOut.drafts > 0 || leftOut.waiting > 0) ? (
              <Notice tone="warning">
                <p className="font-medium">{t('ledger.reports.leftOut')}</p>
                <ul className="flex flex-col gap-1 print:hidden">
                  {leftOut.drafts > 0 ? (
                    <li>
                      <AppLink to={paths.journals}>
                        {t('ledger.reports.leftOutDrafts', { count: leftOut.drafts })}
                      </AppLink>
                    </li>
                  ) : null}
                  {leftOut.waiting > 0 ? (
                    <li>
                      <AppLink to={paths.unposted}>
                        {t('ledger.reports.leftOutWaiting', { count: leftOut.waiting })}
                      </AppLink>
                    </li>
                  ) : null}
                </ul>
                <p className="hidden print:block">
                  {t('ledger.reports.leftOutPrint', {
                    drafts: leftOut.drafts,
                    waiting: leftOut.waiting,
                  })}
                </p>
              </Notice>
            ) : null}

            {current.isError ? (
              <LedgerFailure error={current.error} onRetry={() => void current.refetch()} />
            ) : current.isFetching && current.data === undefined ? (
              <Loading />
            ) : null}

            {report === 'trialBalance' && trial.data !== undefined ? (
              <TrialBalanceView data={trial.data} currency={currency} />
            ) : null}
            {report === 'accountActivity' && activity.data !== undefined ? (
              <ActivityView data={activity.data} currency={currency} />
            ) : null}
            {report === 'receivables' && receivables.data !== undefined ? (
              <ReceivablesView data={receivables.data} />
            ) : null}
            {report === 'profitAndLoss' && profit.data !== undefined ? (
              <ProfitAndLossView data={profit.data} currency={currency} />
            ) : null}
            {report === 'balanceSheet' && balance.data !== undefined ? (
              <BalanceSheetView data={balance.data} currency={currency} />
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
