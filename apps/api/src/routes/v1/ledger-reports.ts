import {
  AGING_BUCKETS,
  accountTypeSchema,
  agingBucket,
  daysBetween,
  fiscalYearOf,
  formatInvoiceReference,
  formatJournalReference,
  fromUnits,
  holds,
  isProfitAndLoss,
  journalKindSchema,
  monthOf,
  monthsBetween,
  naturalBalance,
  nextMonth,
  toUnits,
  type AccountType,
  type AgingBucket,
} from '@integr8/core';
import {
  type JournalLineInput,
  type LedgerAccount,
  type LedgerSettings,
  type TenantTransaction,
  type YearClose,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  auditJournal,
  journalDetail,
  journalDetailSchema,
  LEDGER,
  LEDGER_TAGS,
  requireSettings,
} from './ledger.js';
import { type People, peopleOf, personBody, personSchema } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * The ledger's reports and year-end close (CRM/ERP plan, phase A1; ADR-0009):
 * a trial balance, one account's activity, receivables reconciled with the
 * invoices and payments behind them and aged, and a profit and loss and
 * balance sheet labelled as management reports. Every report counts posted
 * journals only and says how many drafts and waiting documents it leaves out.
 *
 * Closing a fiscal year posts a journal on its last day moving income and
 * expenses into retained earnings, and locks its months. Only the owner
 * reopens a year, with a reason; the closing journal is then reversed and
 * the months stay locked until the owner unlocks the ones that need work.
 */

const accountRefSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: accountTypeSchema,
});

const leftOutSchema = z.object({
  /** Draft journals dated in the report's range: not counted. */
  drafts: z.number().int(),
  /** Documents in the unposted list dated in the range: not counted. */
  waiting: z.number().int(),
});

const amountRowSchema = z.object({ account: accountRefSchema, amount: z.string() });

type AccountRef = z.infer<typeof accountRefSchema>;

function accountRef(account: LedgerAccount): AccountRef {
  return { id: account.id, code: account.code, name: account.name, type: account.type };
}

const byCode = (left: { account: AccountRef }, right: { account: AccountRef }) =>
  left.account.code.localeCompare(right.account.code);

/** Every account, archived ones too: a report names whatever the lines name. */
async function chart(tx: TenantTransaction): Promise<Map<string, LedgerAccount>> {
  const accounts = await tx.ledger.accounts({ includeArchived: true });
  return new Map(accounts.map((account) => [account.id, account]));
}

async function customerNames(tx: TenantTransaction, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.flatMap((id) => (id === null ? [] : [id])))];
  return new Map(
    (await tx.customers.findMany(wanted)).map((customer) => [customer.id, customer.name]),
  );
}

const sum = (values: readonly string[]) =>
  fromUnits(values.reduce((total, value) => total + toUnits(value), 0n));

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

const trialBalanceSchema = z.object({
  date: z.iso.date(),
  /** Each account with posted lines, its net on the debit or the credit side. */
  rows: z.array(z.object({ account: accountRefSchema, debit: z.string(), credit: z.string() })),
  totals: z.object({ debit: z.string(), credit: z.string(), balanced: z.boolean() }),
  leftOut: leftOutSchema,
});

export const trialBalanceRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/reports/trial-balance',
  operationId: 'getTrialBalance',
  summary: 'Trial balance at a date',
  description:
    'Every account’s net of posted lines up to and including `date` (default today), on the debit or credit side. `leftOut` counts drafts and waiting documents dated up to it, which it does not include.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({ date: z.iso.date().optional() }),
  body: noSchema,
  responses: { 200: { description: 'The trial balance.', schema: trialBalanceSchema } },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      const date = query.date ?? (await companyToday(tx));
      const [totals, accounts, leftOut] = await Promise.all([
        tx.ledgerReports.totals({ to: date }),
        chart(tx),
        tx.ledgerReports.leftOut(undefined, date),
      ]);
      const rows = totals
        .flatMap((total) => {
          const account = accounts.get(total.accountId);
          const net = toUnits(total.debit) - toUnits(total.credit);
          if (account === undefined || net === 0n) {
            return [];
          }
          return [
            {
              account: accountRef(account),
              debit: net > 0n ? fromUnits(net) : '0',
              credit: net < 0n ? fromUnits(-net) : '0',
            },
          ];
        })
        .sort(byCode);
      const debit = sum(rows.map((row) => row.debit));
      const credit = sum(rows.map((row) => row.credit));
      return { date, rows, totals: { debit, credit, balanced: debit === credit }, leftOut };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Account activity
// ---------------------------------------------------------------------------

const ACTIVITY_LIMIT = 5000;

const activitySchema = z.object({
  account: accountRefSchema,
  from: z.iso.date(),
  to: z.iso.date(),
  /** Balances on the account's normal side: positive when it holds what it should. */
  opening: z.string(),
  lines: z.array(
    z.object({
      journal: z.object({
        id: z.uuid(),
        reference: z.string().nullable(),
        kind: journalKindSchema,
      }),
      entryDate: z.iso.date(),
      memo: z.string().nullable(),
      debit: z.string(),
      credit: z.string(),
      balance: z.string(),
      customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    }),
  ),
  closing: z.string(),
  /** More than 5,000 lines in the range: narrow it. */
  truncated: z.boolean(),
  leftOut: leftOutSchema,
});

export const accountActivityRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/reports/account-activity',
  operationId: 'getAccountActivity',
  summary: 'One account’s posted lines over a range, with running balance',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({
    accountId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The activity.', schema: activitySchema },
    404: { description: 'No such account.' },
    422: { description: '`to` before `from`.' },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      if (query.to < query.from) {
        throw unprocessable('range_reversed', 'The end of the range is before its start.');
      }
      const account = await tx.ledger.account(query.accountId);
      if (account === undefined) {
        throw notFound('This account does not exist.');
      }
      const dayBefore = new Date(Date.parse(`${query.from}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [before, activity, leftOut] = await Promise.all([
        tx.ledgerReports.totals({ to: dayBefore }),
        tx.ledgerReports.activity(account.id, query.from, query.to, ACTIVITY_LIMIT),
        tx.ledgerReports.leftOut(query.from, query.to),
      ]);
      const prior = before.find((total) => total.accountId === account.id);
      const opening = naturalBalance(account.type, prior?.debit ?? '0', prior?.credit ?? '0');
      const customers = await customerNames(
        tx,
        activity.lines.map((line) => line.customerId),
      );
      let running = toUnits(opening);
      const lines = activity.lines.map((line) => {
        running += toUnits(naturalBalance(account.type, line.debit, line.credit));
        return {
          journal: {
            id: line.journalId,
            reference: line.reference === null ? null : formatJournalReference(line.reference),
            kind: line.kind,
          },
          entryDate: line.entryDate,
          memo: line.lineMemo ?? line.memo,
          debit: line.debit,
          credit: line.credit,
          balance: fromUnits(running),
          customer:
            line.customerId === null
              ? null
              : { id: line.customerId, name: customers.get(line.customerId) ?? '' },
        };
      });
      return {
        account: accountRef(account),
        from: query.from,
        to: query.to,
        opening,
        lines,
        closing: fromUnits(running),
        truncated: activity.truncated,
        leftOut,
      };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Receivables: reconciliation and aging
// ---------------------------------------------------------------------------

const customerRefSchema = z.object({ id: z.uuid(), name: z.string() });

const receivablesSchema = z.object({
  date: z.iso.date(),
  account: accountRefSchema,
  currency: z.string(),
  /** The receivables account against what invoices, credit notes and payments say, per customer. */
  reconciliation: z.object({
    ledger: z.string(),
    documents: z.string(),
    difference: z.string(),
    customers: z.array(
      z.object({
        /** Null for lines on receivables that name no customer. */
        customer: customerRefSchema.nullable(),
        ledger: z.string(),
        documents: z.string(),
        difference: z.string(),
      }),
    ),
  }),
  /** Open invoices today, by how late they are. */
  aging: z.object({
    asOf: z.iso.date(),
    totals: z.record(z.enum(AGING_BUCKETS), z.string()),
    total: z.string(),
    invoices: z.array(
      z.object({
        id: z.uuid(),
        reference: z.string().nullable(),
        customer: customerRefSchema,
        issueDate: z.iso.date(),
        dueDate: z.iso.date().nullable(),
        daysLate: z.number().int(),
        bucket: z.enum(AGING_BUCKETS),
        balance: z.string(),
      }),
    ),
    /** Payments not yet allocated to an invoice: they lower what is owed but age nothing. */
    unallocated: z.array(z.object({ customer: customerRefSchema, amount: z.string() })),
  }),
  leftOut: leftOutSchema,
});

export const receivablesReportRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/reports/receivables',
  operationId: 'getReceivablesReport',
  summary: 'Receivables reconciled with invoices and payments, and aged',
  description:
    'At `date` (default today), the receivables account’s balance per customer against what the company-currency invoices, credit notes and payments say; a difference is a document not posted, posted elsewhere, or a journal by hand. Aging is of the invoices open today.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({ date: z.iso.date().optional() }),
  body: noSchema,
  responses: { 200: { description: 'The report.', schema: receivablesSchema } },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const today = await companyToday(tx);
      const date = query.date ?? today;
      const company = await tx.settings.get();
      const account = await tx.ledger.account(settings.accounts.receivables);
      if (account === undefined) {
        throw notFound('The receivables account does not exist.');
      }
      const dayAfter = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [ledger, documents, open, unallocated, leftOut] = await Promise.all([
        tx.ledgerReports.receivablesByCustomer(account.id, date),
        tx.ledger.receivablesAt(dayAfter, company.currency),
        tx.ledgerReports.openInvoices(company.currency),
        tx.ledgerReports.unallocatedByCustomer(company.currency),
        tx.ledgerReports.leftOut(settings.startDate, date),
      ]);
      const names = await customerNames(tx, [
        ...ledger.map((row) => row.customerId),
        ...documents.map((row) => row.customerId),
        ...open.map((row) => row.customerId),
        ...unallocated.map((row) => row.customerId),
      ]);
      const customer = (id: string) => ({ id, name: names.get(id) ?? '' });

      const keys = new Set<string | null>([
        ...ledger.map((row) => row.customerId),
        ...documents.map((row) => row.customerId),
      ]);
      const rows = [...keys]
        .map((id) => {
          const inLedger = ledger.find((row) => row.customerId === id)?.balance ?? '0';
          const inDocuments =
            id === null ? '0' : (documents.find((row) => row.customerId === id)?.amount ?? '0');
          return {
            customer: id === null ? null : customer(id),
            ledger: inLedger,
            documents: inDocuments,
            difference: fromUnits(toUnits(inLedger) - toUnits(inDocuments)),
          };
        })
        .sort((left, right) =>
          (left.customer?.name ?? '').localeCompare(right.customer?.name ?? ''),
        );
      const ledgerTotal = sum(rows.map((row) => row.ledger));
      const documentTotal = sum(rows.map((row) => row.documents));

      const totals = Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, 0n])) as Record<
        AgingBucket,
        bigint
      >;
      const invoices = open.map((invoice) => {
        const bucket = agingBucket(invoice.dueDate, invoice.issueDate, today);
        totals[bucket] += toUnits(invoice.balance);
        return {
          id: invoice.id,
          reference: invoice.reference === null ? null : formatInvoiceReference(invoice.reference),
          customer: customer(invoice.customerId),
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          daysLate: Math.max(0, daysBetween(invoice.dueDate ?? invoice.issueDate, today)),
          bucket,
          balance: invoice.balance,
        };
      });
      return {
        date,
        account: accountRef(account),
        currency: company.currency,
        reconciliation: {
          ledger: ledgerTotal,
          documents: documentTotal,
          difference: fromUnits(toUnits(ledgerTotal) - toUnits(documentTotal)),
          customers: rows,
        },
        aging: {
          asOf: today,
          totals: Object.fromEntries(
            AGING_BUCKETS.map((bucket) => [bucket, fromUnits(totals[bucket])]),
          ) as Record<AgingBucket, string>,
          total: sum(invoices.map((invoice) => invoice.balance)),
          invoices,
          unallocated: unallocated.map((row) => ({
            customer: customer(row.customerId),
            amount: row.amount,
          })),
        },
        leftOut,
      };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Profit and loss, balance sheet
// ---------------------------------------------------------------------------

const profitAndLossSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  income: z.array(amountRowSchema),
  expenses: z.array(amountRowSchema),
  totalIncome: z.string(),
  totalExpenses: z.string(),
  /** Income less expenses: negative is a loss. */
  net: z.string(),
  leftOut: leftOutSchema,
});

/** Balances of the given types over a range, on their normal side; zero rows left out. */
async function balancesOf(
  tx: TenantTransaction,
  types: readonly AccountType[],
  range: { from?: string; to: string; excludeClosing?: boolean },
): Promise<Map<AccountType, z.infer<typeof amountRowSchema>[]>> {
  const [totals, accounts] = await Promise.all([tx.ledgerReports.totals(range), chart(tx)]);
  const result = new Map<AccountType, z.infer<typeof amountRowSchema>[]>(
    types.map((type) => [type, []]),
  );
  for (const total of totals) {
    const account = accounts.get(total.accountId);
    if (account === undefined || !types.includes(account.type)) {
      continue;
    }
    const amount = naturalBalance(account.type, total.debit, total.credit);
    if (toUnits(amount) !== 0n) {
      result.get(account.type)?.push({ account: accountRef(account), amount });
    }
  }
  for (const rows of result.values()) {
    rows.sort(byCode);
  }
  return result;
}

export const profitAndLossRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/reports/profit-and-loss',
  operationId: 'getProfitAndLoss',
  summary: 'Profit and loss over a range (a management report)',
  description:
    'Income and expense accounts over `from`–`to` from posted journals, leaving out year-end closing. A management report from this ledger, not statutory accounts.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({ from: z.iso.date(), to: z.iso.date() }),
  body: noSchema,
  responses: {
    200: { description: 'The report.', schema: profitAndLossSchema },
    422: { description: '`to` before `from`.' },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      if (query.to < query.from) {
        throw unprocessable('range_reversed', 'The end of the range is before its start.');
      }
      const [balances, leftOut] = await Promise.all([
        balancesOf(tx, ['income', 'expense'], {
          from: query.from,
          to: query.to,
          excludeClosing: true,
        }),
        tx.ledgerReports.leftOut(query.from, query.to),
      ]);
      const income = balances.get('income') ?? [];
      const expenses = balances.get('expense') ?? [];
      const totalIncome = sum(income.map((row) => row.amount));
      const totalExpenses = sum(expenses.map((row) => row.amount));
      return {
        from: query.from,
        to: query.to,
        income,
        expenses,
        totalIncome,
        totalExpenses,
        net: fromUnits(toUnits(totalIncome) - toUnits(totalExpenses)),
        leftOut,
      };
    });
    return { status: 200, body };
  },
});

const balanceSheetSchema = z.object({
  date: z.iso.date(),
  assets: z.array(amountRowSchema),
  liabilities: z.array(amountRowSchema),
  equity: z.array(amountRowSchema),
  /** Income less expenses not yet closed into retained earnings. */
  unclosedEarnings: z.string(),
  totals: z.object({
    assets: z.string(),
    liabilities: z.string(),
    equity: z.string(),
    liabilitiesAndEquity: z.string(),
    balanced: z.boolean(),
  }),
  leftOut: leftOutSchema,
});

export const balanceSheetRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/reports/balance-sheet',
  operationId: 'getBalanceSheet',
  summary: 'Balance sheet at a date (a management report)',
  description:
    'Assets, liabilities and equity from posted journals up to `date` (default today), with earnings not yet closed shown in equity. A management report from this ledger, not statutory accounts.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({ date: z.iso.date().optional() }),
  body: noSchema,
  responses: { 200: { description: 'The report.', schema: balanceSheetSchema } },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      const date = query.date ?? (await companyToday(tx));
      const [balances, leftOut] = await Promise.all([
        balancesOf(tx, ['asset', 'liability', 'equity', 'income', 'expense'], { to: date }),
        tx.ledgerReports.leftOut(undefined, date),
      ]);
      const of = (type: AccountType) => balances.get(type) ?? [];
      const unclosedEarnings = fromUnits(
        toUnits(sum(of('income').map((row) => row.amount))) -
          toUnits(sum(of('expense').map((row) => row.amount))),
      );
      const assets = sum(of('asset').map((row) => row.amount));
      const liabilities = sum(of('liability').map((row) => row.amount));
      const equity = sum([...of('equity').map((row) => row.amount), unclosedEarnings]);
      const liabilitiesAndEquity = fromUnits(toUnits(liabilities) + toUnits(equity));
      return {
        date,
        assets: of('asset'),
        liabilities: of('liability'),
        equity: of('equity'),
        unclosedEarnings,
        totals: {
          assets,
          liabilities,
          equity,
          liabilitiesAndEquity,
          balanced: assets === liabilitiesAndEquity,
        },
        leftOut,
      };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Fiscal years: close and reopen
// ---------------------------------------------------------------------------

const yearSchema = z.object({
  start: z.iso.date(),
  end: z.iso.date(),
  status: z.enum(['open', 'closed']),
  /** Months of the year locked, of twelve (fewer in the ledger's first year). */
  lockedMonths: z.number().int(),
  months: z.number().int(),
  close: z
    .object({
      journal: z.object({ id: z.uuid(), reference: z.string().nullable() }),
      closedBy: personSchema,
      closedAt: z.iso.datetime(),
    })
    .nullable(),
  /** Earlier closes of this year, reopened, newest first. */
  reopened: z.array(
    z.object({
      closedAt: z.iso.datetime(),
      reopenedBy: personSchema,
      reopenedAt: z.iso.datetime(),
      reason: z.string(),
    }),
  ),
  can: z.object({ close: z.boolean(), reopen: z.boolean() }),
});

async function yearBodies(
  tx: TenantTransaction,
  context: RequestContext,
  settings: LedgerSettings,
): Promise<z.infer<typeof yearSchema>[]> {
  const today = await companyToday(tx);
  const [closes, periods, people] = await Promise.all([
    tx.ledgerReports.yearCloses(),
    tx.ledger.periods(),
    peopleOf(tx),
  ]);
  const locked = new Set(periods.filter((period) => period.locked).map((p) => p.periodStart));
  const journals = new Map(
    (
      await Promise.all(
        closes
          .filter((close) => close.reopenedAt === null)
          .map((close) => tx.ledger.find(close.closingJournalId)),
      )
    ).flatMap((journal) => (journal === undefined ? [] : [[journal.id, journal] as const])),
  );
  const years: z.infer<typeof yearSchema>[] = [];
  const { principal } = context;
  const manages = holds(principal, 'ledger.manage');
  const unlocks = holds(principal, 'ledger.unlock');
  for (
    let year = fiscalYearOf(settings.startDate, settings.fiscalStartMonth);
    year.start <= today;
    year = fiscalYearOf(nextMonth(monthOf(year.end)), settings.fiscalStartMonth)
  ) {
    const months = monthsBetween(
      year.start < settings.startDate ? settings.startDate : year.start,
      year.end,
    );
    const inForce = closes.find(
      (close) => close.yearStart === year.start && close.reopenedAt === null,
    );
    const journal = inForce === undefined ? undefined : journals.get(inForce.closingJournalId);
    years.push({
      start: year.start,
      end: year.end,
      status: inForce === undefined ? 'open' : 'closed',
      lockedMonths: months.filter((month) => locked.has(month)).length,
      months: months.length,
      close:
        inForce === undefined
          ? null
          : {
              journal: {
                id: inForce.closingJournalId,
                reference:
                  journal?.reference === null || journal === undefined
                    ? null
                    : formatJournalReference(journal.reference),
              },
              closedBy: personBody(inForce.closedBy, people),
              closedAt: iso(inForce.closedAt),
            },
      reopened: closes
        .filter((close) => close.yearStart === year.start && close.reopenedAt !== null)
        .map((close) => reopenedBody(close, people)),
      can: {
        close: manages && inForce === undefined && year.end < today,
        reopen: unlocks && inForce !== undefined,
      },
    });
  }
  return years.reverse();
}

function reopenedBody(close: YearClose, people: People) {
  return {
    closedAt: iso(close.closedAt),
    reopenedBy: personBody(close.reopenedBy ?? '', people),
    reopenedAt: isoOrNull(close.reopenedAt) ?? '',
    reason: close.reopenReason ?? '',
  };
}

export const listYearsRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/years',
  operationId: 'listLedgerYears',
  summary: 'Fiscal years since the ledger started, newest first, and whether each is closed',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The years.', schema: z.object({ items: z.array(yearSchema) }) },
  },
  handler: async (_request, context) => {
    const { principal } = context;
    const items = await withTenant(principal.tenantId, async (tx) =>
      yearBodies(tx, context, await requireSettings(tx)),
    );
    return { status: 200, body: { items } };
  },
});

const yearParams = z.object({ yearStart: z.iso.date() });

/** The fiscal year starting on `yearStart`, or 404 when no year of this ledger starts then. */
function yearOr404(settings: LedgerSettings, yearStart: string) {
  const year = fiscalYearOf(yearStart, settings.fiscalStartMonth);
  if (year.start !== yearStart || year.end < settings.startDate) {
    throw notFound('No fiscal year of this ledger starts on that date.');
  }
  return year;
}

/** The lines closing a year: every income and expense balance to zero, the difference to retained earnings. */
async function closingLines(
  tx: TenantTransaction,
  settings: LedgerSettings,
  year: { start: string; end: string },
): Promise<JournalLineInput[]> {
  const [totals, accounts] = await Promise.all([
    tx.ledgerReports.totals({ from: year.start, to: year.end }),
    chart(tx),
  ]);
  const lines: JournalLineInput[] = [];
  let toRetained = 0n;
  const ordered = totals
    .flatMap((total) => {
      const account = accounts.get(total.accountId);
      return account === undefined || !isProfitAndLoss(account.type) ? [] : [{ total, account }];
    })
    .sort((left, right) => left.account.code.localeCompare(right.account.code));
  for (const { total, account } of ordered) {
    const net = toUnits(total.debit) - toUnits(total.credit);
    if (net === 0n) {
      continue;
    }
    if (account.archivedAt !== null) {
      throw conflict(
        'account_archived',
        `${account.code} ${account.name} is archived and holds a balance for the year: bring it back into use to close the year.`,
      );
    }
    // Debit balance (an expense): credit it. Credit balance (income): debit it.
    lines.push(
      net > 0n
        ? { accountId: account.id, credit: fromUnits(net), memo: null, customerId: null }
        : { accountId: account.id, debit: fromUnits(-net), memo: null, customerId: null },
    );
    toRetained += net;
  }
  if (lines.length === 0) {
    return [];
  }
  if (toRetained !== 0n) {
    // A profit (credits ahead) credits retained earnings; a loss debits it.
    lines.push(
      toRetained < 0n
        ? {
            accountId: settings.accounts.retainedEarnings,
            credit: fromUnits(-toRetained),
            memo: null,
            customerId: null,
          }
        : {
            accountId: settings.accounts.retainedEarnings,
            debit: fromUnits(toRetained),
            memo: null,
            customerId: null,
          },
    );
  }
  return lines;
}

export const closeYearRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/years/:yearStart/close',
  operationId: 'closeLedgerYear',
  summary: 'Close a fiscal year into retained earnings',
  description:
    'Once the year has ended. Posts a closing journal on its last day that brings every income and expense account to zero against retained earnings, and locks every month of the year. Refused while drafts or waiting documents are dated in it (409 `year_not_ready`), when it is already closed (409 `year_closed`), or when it has no income or expense (409 `nothing_to_close`). Honours `Idempotency-Key`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.manage',
  feature: LEDGER,
  idempotent: true,
  params: yearParams,
  query: noSchema,
  body: noSchema,
  responses: {
    201: { description: 'The closing journal.', schema: journalDetailSchema },
    404: { description: 'No such fiscal year.' },
    409: { description: 'Not ended, not ready, already closed, or nothing to close.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const year = yearOr404(settings, params.yearStart);
      if (year.end >= (await companyToday(tx))) {
        throw conflict('year_not_ended', `This fiscal year ends on ${year.end}.`);
      }
      if ((await tx.ledgerReports.closeInForce(year.start)) !== undefined) {
        throw conflict('year_closed', 'This fiscal year is already closed.');
      }
      const from = year.start < settings.startDate ? settings.startDate : year.start;
      const leftOut = await tx.ledgerReports.leftOut(from, year.end);
      if (leftOut.drafts > 0 || leftOut.waiting > 0) {
        throw conflict(
          'year_not_ready',
          `Post or discard the ${String(leftOut.drafts)} draft journal(s), and post or set aside the ${String(leftOut.waiting)} waiting document(s), dated in this year first.`,
        );
      }
      const retained = await tx.ledger.account(settings.accounts.retainedEarnings);
      if (retained?.archivedAt !== null) {
        throw conflict('account_archived', 'The retained earnings account must be in use.');
      }
      const lines = await closingLines(tx, settings, year);
      if (lines.length === 0) {
        throw conflict(
          'nothing_to_close',
          'This year has no income or expense to close; lock its months instead.',
        );
      }
      const draft = await tx.ledger.createDraft(
        {
          kind: 'closing',
          entryDate: year.end,
          memo: `Year-end close ${year.start} – ${year.end}`,
        },
        lines,
        principal.userId,
      );
      const journal = await tx.ledger.post(draft.id, principal.userId);
      const locked: string[] = [];
      for (const month of monthsBetween(from, year.end)) {
        if ((await tx.ledger.setPeriodLocked(month, true, principal.userId, null)).changed) {
          locked.push(month);
        }
      }
      await tx.ledgerReports.recordClose(year.start, journal.id, principal.userId);
      await auditJournal(tx, context, 'ledger.year_closed', journal, {
        yearStart: year.start,
        yearEnd: year.end,
        lockedMonths: locked,
      });
      return journalDetail(tx, principal, journal);
    });
    return { status: 201, body: detail };
  },
});

export const reopenYearRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/years/:yearStart/reopen',
  operationId: 'reopenLedgerYear',
  summary: 'Reopen a closed fiscal year',
  description:
    'The owner’s, with a reason kept with the year. Reverses the closing journal on the year’s last day. The months stay locked: unlock the ones that need work, then close the year again. Honours `Idempotency-Key`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.unlock',
  feature: LEDGER,
  idempotent: true,
  params: yearParams,
  query: noSchema,
  body: z.object({ reason: z.string().trim().min(1).max(1000) }),
  responses: {
    200: { description: 'The reversal of the closing journal.', schema: journalDetailSchema },
    404: { description: 'No such fiscal year.' },
    409: { description: 'Not closed.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const year = yearOr404(settings, params.yearStart);
      const close = await tx.ledgerReports.closeInForce(year.start);
      if (close === undefined) {
        throw conflict('year_open', 'This fiscal year is not closed.');
      }
      const closing = await tx.ledger.lock(close.closingJournalId);
      if (closing === undefined) {
        throw notFound('The closing journal does not exist.');
      }
      const lines = await tx.ledger.lines(closing.id);
      const reference = closing.reference === null ? '' : formatJournalReference(closing.reference);
      const draft = await tx.ledger.createDraft(
        {
          kind: 'reversal',
          entryDate: closing.entryDate,
          memo: `Reopening ${year.start} – ${year.end} (reverses ${reference})`,
          reversalOf: closing.id,
        },
        lines.map((line) => ({
          accountId: line.accountId,
          debit: line.credit === '0' ? undefined : line.credit,
          credit: line.debit === '0' ? undefined : line.debit,
          memo: line.memo,
          customerId: line.customerId,
        })),
        principal.userId,
      );
      const reversal = await tx.ledger.post(draft.id, principal.userId);
      await tx.ledgerReports.recordReopen(close.id, reversal.id, principal.userId, body.reason);
      await auditJournal(tx, context, 'ledger.year_reopened', reversal, {
        yearStart: year.start,
        reverses: reference,
        reason: body.reason,
      });
      return journalDetail(tx, principal, reversal);
    });
    return { status: 200, body: detail };
  },
});

export const ledgerReportRoutes = [
  trialBalanceRoute,
  accountActivityRoute,
  receivablesReportRoute,
  profitAndLossRoute,
  balanceSheetRoute,
  listYearsRoute,
  closeYearRoute,
  reopenYearRoute,
];
