import { AGING_BUCKETS, toUnits } from '@integr8/core';
import { formatCalendarDate, type TFunction, useTranslation } from '@integr8/i18n';
import type { ReactNode } from 'react';
import {
  type AccountActivity,
  type BalanceSheet,
  type ProfitAndLoss,
  type ReceivablesReport,
  type TrialBalance,
  useOperations,
} from '../api.js';
import { Amount, AppLink, useKindName } from './ledger-parts.js';

/**
 * The ledger's reports as tables, and the same rows as CSV (ADR-0009). Every
 * figure comes from posted journals; the amounts in a CSV are the decimal
 * strings themselves, so a spreadsheet adds them up exactly.
 */

export type CsvRow = (string | number | null)[];

const th = 'px-3 py-2 font-medium';
const td = 'px-3 py-2';

function Table({ children, caption }: { children: ReactNode; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface print:overflow-visible print:border-0">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

function Head({ columns }: { columns: readonly { label: string; end?: boolean }[] }) {
  return (
    <thead className="bg-surface-muted text-content-muted">
      <tr>
        {columns.map((column) => (
          <th
            key={column.label}
            scope="col"
            className={`${th} ${column.end === true ? 'text-end' : 'text-start'}`}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Code({ code }: { code: string }) {
  return (
    <span dir="ltr" className="tabular-nums">
      {code}
    </span>
  );
}

/** Whether a report adds up, in words. */
function Balanced({ balanced }: { balanced: boolean }) {
  const { t } = useTranslation();
  return (
    <p role="status" className="text-sm text-content">
      {balanced ? `✓ ${t('ledger.reports.balanced')}` : `≠ ${t('ledger.reports.notBalanced')}`}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export function TrialBalanceView({ data, currency }: { data: TrialBalance; currency: string }) {
  const { t } = useTranslation();
  if (data.rows.length === 0) {
    return <p className="text-sm text-content-muted">{t('ledger.reports.nothingPosted')}</p>;
  }
  return (
    <>
      <Table caption={t('ledger.reports.trialBalance')}>
        <Head
          columns={[
            { label: t('ledger.accounts.code') },
            { label: t('ledger.accounts.name') },
            { label: t('ledger.accounts.type') },
            { label: t('ledger.lines.debit'), end: true },
            { label: t('ledger.lines.credit'), end: true },
          ]}
        />
        <tbody className="divide-y divide-border-subtle">
          {data.rows.map((row) => (
            <tr key={row.account.id}>
              <td className={td}>
                <Code code={row.account.code} />
              </td>
              <td className={`${td} text-content`}>{row.account.name}</td>
              <td className={`${td} text-content-muted`}>
                {t(`ledger.accountType.${row.account.type}`)}
              </td>
              <td className={`${td} text-end`}>
                <Amount value={row.debit} currency={currency} blankZero />
              </td>
              <td className={`${td} text-end`}>
                <Amount value={row.credit} currency={currency} blankZero />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border-subtle bg-surface-muted">
          <tr>
            <th scope="row" colSpan={3} className={`${th} text-start text-content`}>
              {t('ledger.lines.totals')}
            </th>
            <td className={`${td} text-end`}>
              <Amount value={data.totals.debit} currency={currency} strong />
            </td>
            <td className={`${td} text-end`}>
              <Amount value={data.totals.credit} currency={currency} strong />
            </td>
          </tr>
        </tfoot>
      </Table>
      <Balanced balanced={data.totals.balanced} />
    </>
  );
}

export function trialBalanceCsv(data: TrialBalance, t: TFunction): CsvRow[] {
  return [
    [t('ledger.reports.trialBalance'), data.date],
    [t('ledger.managementShort')],
    [],
    [
      t('ledger.accounts.code'),
      t('ledger.accounts.name'),
      t('ledger.accounts.type'),
      t('ledger.lines.debit'),
      t('ledger.lines.credit'),
    ],
    ...data.rows.map((row) => [
      row.account.code,
      row.account.name,
      t(`ledger.accountType.${row.account.type}`),
      row.debit,
      row.credit,
    ]),
    [t('ledger.lines.totals'), null, null, data.totals.debit, data.totals.credit],
  ];
}

// ---------------------------------------------------------------------------
// Account activity
// ---------------------------------------------------------------------------

export function ActivityView({ data, currency }: { data: AccountActivity; currency: string }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  const kindName = useKindName();
  return (
    <>
      {data.truncated ? (
        <p role="status" className="text-sm text-content">
          {t('ledger.reports.truncated')}
        </p>
      ) : null}
      <Table caption={t('ledger.reports.accountActivity')}>
        <Head
          columns={[
            { label: t('ledger.reports.date') },
            { label: t('ledger.reports.journal') },
            { label: t('ledger.lines.memo') },
            { label: t('ledger.lines.customer') },
            { label: t('ledger.lines.debit'), end: true },
            { label: t('ledger.lines.credit'), end: true },
            { label: t('ledger.reports.balance'), end: true },
          ]}
        />
        <tbody className="divide-y divide-border-subtle">
          <tr className="bg-surface-muted">
            <th scope="row" colSpan={6} className={`${th} text-start text-content`}>
              {t('ledger.reports.openingBalance')}
            </th>
            <td className={`${td} text-end`}>
              <Amount value={data.opening} currency={currency} strong />
            </td>
          </tr>
          {data.lines.map((line, index) => (
            <tr key={`${line.journal.id}-${String(index)}`}>
              <td className={`${td} whitespace-nowrap text-content-muted`}>
                {formatCalendarDate(line.entryDate, { locale })}
              </td>
              <td className={td}>
                <AppLink to={paths.journal(line.journal.id)} ltr={line.journal.reference !== null}>
                  {line.journal.reference ?? kindName(line.journal.kind)}
                </AppLink>
              </td>
              <td className={`${td} text-content`} dir="auto">
                {line.memo ?? ''}
              </td>
              <td className={`${td} text-content`}>{line.customer?.name ?? ''}</td>
              <td className={`${td} text-end`}>
                <Amount value={line.debit} currency={currency} blankZero />
              </td>
              <td className={`${td} text-end`}>
                <Amount value={line.credit} currency={currency} blankZero />
              </td>
              <td className={`${td} text-end`}>
                <Amount value={line.balance} currency={currency} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border-subtle bg-surface-muted">
          <tr>
            <th scope="row" colSpan={6} className={`${th} text-start text-content`}>
              {t('ledger.reports.closingBalance')}
            </th>
            <td className={`${td} text-end`}>
              <Amount value={data.closing} currency={currency} strong />
            </td>
          </tr>
        </tfoot>
      </Table>
      {data.lines.length === 0 ? (
        <p className="text-sm text-content-muted">{t('ledger.reports.noActivity')}</p>
      ) : null}
    </>
  );
}

export function activityCsv(data: AccountActivity, t: TFunction): CsvRow[] {
  return [
    [t('ledger.reports.accountActivity'), data.account.code, data.account.name],
    [t('ledger.reports.from'), data.from, t('ledger.reports.to'), data.to],
    [t('ledger.managementShort')],
    [],
    [
      t('ledger.reports.date'),
      t('ledger.reports.journal'),
      t('ledger.lines.memo'),
      t('ledger.lines.customer'),
      t('ledger.lines.debit'),
      t('ledger.lines.credit'),
      t('ledger.reports.balance'),
    ],
    [t('ledger.reports.openingBalance'), null, null, null, null, null, data.opening],
    ...data.lines.map((line) => [
      line.entryDate,
      line.journal.reference ?? t(`ledger.kind.${line.journal.kind}`),
      line.memo,
      line.customer?.name ?? null,
      line.debit,
      line.credit,
      line.balance,
    ]),
    [t('ledger.reports.closingBalance'), null, null, null, null, null, data.closing],
  ];
}

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

export function ReceivablesView({ data }: { data: ReceivablesReport }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  const currency = data.currency;
  const reconciliation = data.reconciliation;
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="receivables-reconciliation" className="flex flex-col gap-3">
        <h3 id="receivables-reconciliation" className="text-base font-semibold text-content">
          {t('ledger.reports.reconciliation')}
        </h3>
        <p className="text-sm text-content-muted">
          {t('ledger.reports.reconciliationIntro', {
            account: `${data.account.code} ${data.account.name}`,
          })}
        </p>
        <Table caption={t('ledger.reports.reconciliation')}>
          <Head
            columns={[
              { label: t('ledger.lines.customer') },
              { label: t('ledger.reports.inLedger'), end: true },
              { label: t('ledger.reports.inDocuments'), end: true },
              { label: t('ledger.reports.difference'), end: true },
            ]}
          />
          <tbody className="divide-y divide-border-subtle">
            {reconciliation.customers.map((row) => (
              <tr key={row.customer?.id ?? 'none'}>
                <td className={`${td} text-content`}>
                  {row.customer?.name ?? t('ledger.reports.noCustomer')}
                </td>
                <td className={`${td} text-end`}>
                  <Amount value={row.ledger} currency={currency} />
                </td>
                <td className={`${td} text-end`}>
                  <Amount value={row.documents} currency={currency} />
                </td>
                <td className={`${td} text-end`}>
                  {toUnits(row.difference) === 0n ? (
                    <span className="text-content-muted">—</span>
                  ) : (
                    <Amount value={row.difference} currency={currency} strong />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border-subtle bg-surface-muted">
            <tr>
              <th scope="row" className={`${th} text-start text-content`}>
                {t('ledger.lines.totals')}
              </th>
              <td className={`${td} text-end`}>
                <Amount value={reconciliation.ledger} currency={currency} strong />
              </td>
              <td className={`${td} text-end`}>
                <Amount value={reconciliation.documents} currency={currency} strong />
              </td>
              <td className={`${td} text-end`}>
                <Amount value={reconciliation.difference} currency={currency} strong />
              </td>
            </tr>
          </tfoot>
        </Table>
        <p role="status" className="text-sm text-content">
          {toUnits(reconciliation.difference) === 0n
            ? t('ledger.reports.reconciled')
            : t('ledger.reports.notReconciled')}
        </p>
      </section>

      <section aria-labelledby="receivables-aging" className="flex flex-col gap-3">
        <h3 id="receivables-aging" className="text-base font-semibold text-content">
          {t('ledger.reports.aging')}
        </h3>
        <p className="text-sm text-content-muted">
          {t('ledger.reports.agingIntro', {
            date: formatCalendarDate(data.aging.asOf, { locale }),
          })}
        </p>
        <Table caption={t('ledger.reports.aging')}>
          <Head
            columns={[
              { label: t('ledger.reports.bucket') },
              { label: t('ledger.reports.owed'), end: true },
            ]}
          />
          <tbody className="divide-y divide-border-subtle">
            {AGING_BUCKETS.map((bucket) => (
              <tr key={bucket}>
                <th scope="row" className={`${td} text-start font-normal text-content`}>
                  {t(`ledger.aging.${bucket}`)}
                </th>
                <td className={`${td} text-end`}>
                  <Amount value={data.aging.totals[bucket] ?? '0'} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border-subtle bg-surface-muted">
            <tr>
              <th scope="row" className={`${th} text-start text-content`}>
                {t('ledger.lines.totals')}
              </th>
              <td className={`${td} text-end`}>
                <Amount value={data.aging.total} currency={currency} strong />
              </td>
            </tr>
          </tfoot>
        </Table>
      </section>

      <section aria-labelledby="receivables-open" className="flex flex-col gap-3">
        <h3 id="receivables-open" className="text-base font-semibold text-content">
          {t('ledger.reports.openInvoices')}
        </h3>
        {data.aging.invoices.length === 0 ? (
          <p className="text-sm text-content-muted">{t('ledger.reports.noOpenInvoices')}</p>
        ) : (
          <Table caption={t('ledger.reports.openInvoices')}>
            <Head
              columns={[
                { label: t('ledger.reports.invoice') },
                { label: t('ledger.lines.customer') },
                { label: t('ledger.reports.issued') },
                { label: t('ledger.reports.due') },
                { label: t('ledger.reports.daysLate'), end: true },
                { label: t('ledger.reports.bucket') },
                { label: t('ledger.reports.owed'), end: true },
              ]}
            />
            <tbody className="divide-y divide-border-subtle">
              {data.aging.invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className={td}>
                    <AppLink to={paths.invoice(invoice.id)} ltr>
                      {invoice.reference ?? t('ledger.source.invoice')}
                    </AppLink>
                  </td>
                  <td className={`${td} text-content`}>{invoice.customer.name}</td>
                  <td className={`${td} whitespace-nowrap text-content-muted`}>
                    {formatCalendarDate(invoice.issueDate, { locale })}
                  </td>
                  <td className={`${td} whitespace-nowrap text-content-muted`}>
                    {invoice.dueDate === null
                      ? ''
                      : formatCalendarDate(invoice.dueDate, { locale })}
                  </td>
                  <td className={`${td} text-end tabular-nums`}>{invoice.daysLate}</td>
                  <td className={`${td} text-content`}>{t(`ledger.aging.${invoice.bucket}`)}</td>
                  <td className={`${td} text-end`}>
                    <Amount value={invoice.balance} currency={currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="receivables-unallocated" className="flex flex-col gap-3">
        <h3 id="receivables-unallocated" className="text-base font-semibold text-content">
          {t('ledger.reports.unallocated')}
        </h3>
        <p className="text-sm text-content-muted">{t('ledger.reports.unallocatedIntro')}</p>
        {data.aging.unallocated.length === 0 ? (
          <p className="text-sm text-content-muted">{t('ledger.reports.noUnallocated')}</p>
        ) : (
          <Table caption={t('ledger.reports.unallocated')}>
            <Head
              columns={[
                { label: t('ledger.lines.customer') },
                { label: t('ledger.reports.onAccount'), end: true },
              ]}
            />
            <tbody className="divide-y divide-border-subtle">
              {data.aging.unallocated.map((row) => (
                <tr key={row.customer.id}>
                  <td className={`${td} text-content`}>{row.customer.name}</td>
                  <td className={`${td} text-end`}>
                    <Amount value={row.amount} currency={currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

export function receivablesCsv(data: ReceivablesReport, t: TFunction): CsvRow[] {
  const reconciliation = data.reconciliation;
  return [
    [t('ledger.reports.receivables'), data.date, data.currency],
    [t('ledger.managementShort')],
    [],
    [t('ledger.reports.reconciliation'), data.account.code, data.account.name],
    [
      t('ledger.lines.customer'),
      t('ledger.reports.inLedger'),
      t('ledger.reports.inDocuments'),
      t('ledger.reports.difference'),
    ],
    ...reconciliation.customers.map((row) => [
      row.customer?.name ?? t('ledger.reports.noCustomer'),
      row.ledger,
      row.documents,
      row.difference,
    ]),
    [
      t('ledger.lines.totals'),
      reconciliation.ledger,
      reconciliation.documents,
      reconciliation.difference,
    ],
    [],
    [t('ledger.reports.aging'), data.aging.asOf],
    [t('ledger.reports.bucket'), t('ledger.reports.owed')],
    ...AGING_BUCKETS.map((bucket) => [
      t(`ledger.aging.${bucket}`),
      data.aging.totals[bucket] ?? '0',
    ]),
    [t('ledger.lines.totals'), data.aging.total],
    [],
    [t('ledger.reports.openInvoices')],
    [
      t('ledger.reports.invoice'),
      t('ledger.lines.customer'),
      t('ledger.reports.issued'),
      t('ledger.reports.due'),
      t('ledger.reports.daysLate'),
      t('ledger.reports.bucket'),
      t('ledger.reports.owed'),
    ],
    ...data.aging.invoices.map((invoice) => [
      invoice.reference,
      invoice.customer.name,
      invoice.issueDate,
      invoice.dueDate,
      invoice.daysLate,
      t(`ledger.aging.${invoice.bucket}`),
      invoice.balance,
    ]),
    [],
    [t('ledger.reports.unallocated')],
    [t('ledger.lines.customer'), t('ledger.reports.onAccount')],
    ...data.aging.unallocated.map((row) => [row.customer.name, row.amount]),
  ];
}

// ---------------------------------------------------------------------------
// Profit and loss, balance sheet
// ---------------------------------------------------------------------------

interface AmountRow {
  account: { id: string; code: string; name: string };
  amount: string;
}

/** One block of a statement: its accounts and its total. */
function StatementBlock({
  title,
  rows,
  total,
  totalLabel,
  currency,
  extra,
}: {
  title: string;
  rows: readonly AmountRow[];
  total: string;
  totalLabel: string;
  currency: string;
  extra?: { label: string; amount: string };
}) {
  const { t } = useTranslation();
  return (
    <tbody className="border-t border-border-subtle">
      <tr>
        <th scope="rowgroup" colSpan={3} className={`${th} text-start text-content`}>
          {title}
        </th>
      </tr>
      {rows.length === 0 && extra === undefined ? (
        <tr>
          <td colSpan={3} className={`${td} text-content-muted`}>
            {t('ledger.reports.none')}
          </td>
        </tr>
      ) : null}
      {rows.map((row) => (
        <tr key={row.account.id}>
          <td className={`${td} w-24`}>
            <Code code={row.account.code} />
          </td>
          <td className={`${td} text-content`}>{row.account.name}</td>
          <td className={`${td} text-end`}>
            <Amount value={row.amount} currency={currency} />
          </td>
        </tr>
      ))}
      {extra === undefined ? null : (
        <tr>
          <td className={td} />
          <td className={`${td} text-content`}>{extra.label}</td>
          <td className={`${td} text-end`}>
            <Amount value={extra.amount} currency={currency} />
          </td>
        </tr>
      )}
      <tr className="bg-surface-muted">
        <th scope="row" colSpan={2} className={`${th} text-start text-content`}>
          {totalLabel}
        </th>
        <td className={`${td} text-end`}>
          <Amount value={total} currency={currency} strong />
        </td>
      </tr>
    </tbody>
  );
}

export function ProfitAndLossView({ data, currency }: { data: ProfitAndLoss; currency: string }) {
  const { t } = useTranslation();
  const loss = toUnits(data.net) < 0n;
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface print:overflow-visible print:border-0">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('ledger.reports.profitAndLoss')}</caption>
        <StatementBlock
          title={t('ledger.reports.income')}
          rows={data.income}
          total={data.totalIncome}
          totalLabel={t('ledger.reports.totalIncome')}
          currency={currency}
        />
        <StatementBlock
          title={t('ledger.reports.expenses')}
          rows={data.expenses}
          total={data.totalExpenses}
          totalLabel={t('ledger.reports.totalExpenses')}
          currency={currency}
        />
        <tfoot className="border-t-2 border-border-subtle">
          <tr>
            <th scope="row" colSpan={2} className={`${th} text-start text-content`}>
              {loss ? t('ledger.reports.netLoss') : t('ledger.reports.netProfit')}
            </th>
            <td className={`${td} text-end`}>
              <Amount value={data.net} currency={currency} strong />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function profitAndLossCsv(data: ProfitAndLoss, t: TFunction): CsvRow[] {
  return [
    [t('ledger.reports.profitAndLoss'), data.from, data.to],
    [t('ledger.reports.managementReport')],
    [],
    [t('ledger.accounts.code'), t('ledger.accounts.name'), t('ledger.reports.amount')],
    [t('ledger.reports.income')],
    ...data.income.map((row) => [row.account.code, row.account.name, row.amount]),
    [t('ledger.reports.totalIncome'), null, data.totalIncome],
    [t('ledger.reports.expenses')],
    ...data.expenses.map((row) => [row.account.code, row.account.name, row.amount]),
    [t('ledger.reports.totalExpenses'), null, data.totalExpenses],
    [
      toUnits(data.net) < 0n ? t('ledger.reports.netLoss') : t('ledger.reports.netProfit'),
      null,
      data.net,
    ],
  ];
}

export function BalanceSheetView({ data, currency }: { data: BalanceSheet; currency: string }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface print:overflow-visible print:border-0">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('ledger.reports.balanceSheet')}</caption>
          <StatementBlock
            title={t('ledger.reports.assets')}
            rows={data.assets}
            total={data.totals.assets}
            totalLabel={t('ledger.reports.totalAssets')}
            currency={currency}
          />
          <StatementBlock
            title={t('ledger.reports.liabilities')}
            rows={data.liabilities}
            total={data.totals.liabilities}
            totalLabel={t('ledger.reports.totalLiabilities')}
            currency={currency}
          />
          <StatementBlock
            title={t('ledger.reports.equity')}
            rows={data.equity}
            total={data.totals.equity}
            totalLabel={t('ledger.reports.totalEquity')}
            currency={currency}
            extra={{ label: t('ledger.reports.unclosedEarnings'), amount: data.unclosedEarnings }}
          />
          <tfoot className="border-t-2 border-border-subtle">
            <tr>
              <th scope="row" colSpan={2} className={`${th} text-start text-content`}>
                {t('ledger.reports.liabilitiesAndEquity')}
              </th>
              <td className={`${td} text-end`}>
                <Amount value={data.totals.liabilitiesAndEquity} currency={currency} strong />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Balanced balanced={data.totals.balanced} />
    </>
  );
}

export function balanceSheetCsv(data: BalanceSheet, t: TFunction): CsvRow[] {
  const block = (rows: readonly AmountRow[]) =>
    rows.map((row) => [row.account.code, row.account.name, row.amount]);
  return [
    [t('ledger.reports.balanceSheet'), data.date],
    [t('ledger.reports.managementReport')],
    [],
    [t('ledger.accounts.code'), t('ledger.accounts.name'), t('ledger.reports.amount')],
    [t('ledger.reports.assets')],
    ...block(data.assets),
    [t('ledger.reports.totalAssets'), null, data.totals.assets],
    [t('ledger.reports.liabilities')],
    ...block(data.liabilities),
    [t('ledger.reports.totalLiabilities'), null, data.totals.liabilities],
    [t('ledger.reports.equity')],
    ...block(data.equity),
    [null, t('ledger.reports.unclosedEarnings'), data.unclosedEarnings],
    [t('ledger.reports.totalEquity'), null, data.totals.equity],
    [t('ledger.reports.liabilitiesAndEquity'), null, data.totals.liabilitiesAndEquity],
  ];
}
