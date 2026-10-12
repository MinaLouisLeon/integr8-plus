import { type JournalKind, toUserId, type UserId } from '@integr8/core';
import { sql } from 'kysely';
import { toDayString, trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * What the ledger reports read (CRM/ERP plan, phase A1; ADR-0009): totals of
 * posted lines by account over a range, one account's lines, receivables by
 * customer, open invoices for aging, and the record of closed years. Only
 * posted journals count; drafts and waiting documents are counted so a report
 * can say what it leaves out.
 */

export interface AccountTotals {
  accountId: string;
  debit: string;
  credit: string;
}

export interface ActivityLine {
  journalId: string;
  reference: number | null;
  entryDate: string;
  kind: JournalKind;
  memo: string | null;
  lineMemo: string | null;
  debit: string;
  credit: string;
  customerId: string | null;
}

export interface OpenInvoice {
  id: string;
  reference: number | null;
  customerId: string;
  issueDate: string;
  dueDate: string | null;
  balance: string;
}

export interface YearClose {
  id: string;
  /** `YYYY-MM-01`. */
  yearStart: string;
  closingJournalId: string;
  closedBy: UserId;
  closedAt: Date;
  reopenedBy: UserId | null;
  reopenedAt: Date | null;
  reopenReason: string | null;
  reopeningJournalId: string | null;
}

export class LedgerReportsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /**
   * Debits and credits of posted lines by account, dated within the range
   * (either end open). Accounts without lines are left out. `excludeClosing`
   * leaves out year-end closing journals and their reversals, for a profit
   * and loss that shows what the year earned rather than zero.
   */
  async totals(range: {
    from?: string | undefined;
    to?: string | undefined;
    excludeClosing?: boolean | undefined;
  }): Promise<AccountTotals[]> {
    const { rows } = await sql<{ account_id: string; debit: string; credit: string }>`
      select l.account_id, sum(l.debit)::text as debit, sum(l.credit)::text as credit
        from erp_journal_lines l
        join erp_journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
       where l.tenant_id = ${this.tenantId} and j.status = 'posted'
         and (${range.from ?? null}::date is null or j.entry_date >= ${range.from ?? null}::date)
         and (${range.to ?? null}::date is null or j.entry_date <= ${range.to ?? null}::date)
         and (not ${range.excludeClosing === true} or not (
               j.kind = 'closing'
               or (j.kind = 'reversal' and exists (
                     select 1 from erp_journals c
                      where c.tenant_id = j.tenant_id and c.id = j.reversal_of and c.kind = 'closing'))))
       group by l.account_id
    `.execute(this.db);
    return rows.map((row) => ({
      accountId: row.account_id,
      debit: trimDecimal(row.debit),
      credit: trimDecimal(row.credit),
    }));
  }

  /** One account's posted lines in the range, in date and number order; `limit + 1` read to tell if more. */
  async activity(
    accountId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<{ lines: ActivityLine[]; truncated: boolean }> {
    const { rows } = await sql<{
      journal_id: string;
      reference: number | null;
      entry_date: string | Date;
      kind: JournalKind;
      memo: string | null;
      line_memo: string | null;
      debit: string;
      credit: string;
      customer_id: string | null;
    }>`
      select j.id as journal_id, j.reference, j.entry_date, j.kind, j.memo, l.memo as line_memo,
             l.debit::text as debit, l.credit::text as credit, l.customer_id
        from erp_journal_lines l
        join erp_journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
       where l.tenant_id = ${this.tenantId} and l.account_id = ${accountId}::uuid
         and j.status = 'posted' and j.entry_date between ${from}::date and ${to}::date
       order by j.entry_date, j.reference, l.line_no
       limit ${limit + 1}
    `.execute(this.db);
    return {
      lines: rows.slice(0, limit).map((row) => ({
        journalId: row.journal_id,
        reference: row.reference,
        entryDate: toDayString(row.entry_date) ?? '',
        kind: row.kind,
        memo: row.memo,
        lineMemo: row.line_memo,
        debit: trimDecimal(row.debit),
        credit: trimDecimal(row.credit),
        customerId: row.customer_id,
      })),
      truncated: rows.length > limit,
    };
  }

  /** What posted lines on receivables say each customer owes at the end of `asOf`; null for lines without one. */
  async receivablesByCustomer(
    accountId: string,
    asOf: string,
  ): Promise<{ customerId: string | null; balance: string }[]> {
    const { rows } = await sql<{ customer_id: string | null; balance: string }>`
      select l.customer_id, (sum(l.debit) - sum(l.credit))::text as balance
        from erp_journal_lines l
        join erp_journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
       where l.tenant_id = ${this.tenantId} and l.account_id = ${accountId}::uuid
         and j.status = 'posted' and j.entry_date <= ${asOf}::date
       group by l.customer_id
      having sum(l.debit) <> sum(l.credit)
    `.execute(this.db);
    return rows.map((row) => ({ customerId: row.customer_id, balance: trimDecimal(row.balance) }));
  }

  /** Issued invoices in `currency` that still owe something today, oldest due first. */
  async openInvoices(currency: string): Promise<OpenInvoice[]> {
    const { rows } = await sql<{
      id: string;
      reference: number | null;
      customer_id: string;
      issue_date: string | Date;
      due_date: string | Date | null;
      balance: string;
    }>`
      select i.id, i.reference, i.customer_id, i.issue_date, i.due_date, b.balance::text as balance
        from erp_invoices i
        cross join lateral (select erp_invoice_balance(i.tenant_id, i.id) as balance) b
       where i.tenant_id = ${this.tenantId} and i.status = 'issued'
         and i.currency_code = ${currency} and b.balance > 0
       order by coalesce(i.due_date, i.issue_date), i.reference
    `.execute(this.db);
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      customerId: row.customer_id,
      issueDate: toDayString(row.issue_date) ?? '',
      dueDate: toDayString(row.due_date),
      balance: trimDecimal(row.balance),
    }));
  }

  /** Payments in `currency` not yet allocated to invoices, by customer. */
  async unallocatedByCustomer(currency: string): Promise<{ customerId: string; amount: string }[]> {
    const { rows } = await sql<{ customer_id: string; amount: string }>`
      select r.customer_id, sum(r.amount - coalesce(a.allocated, 0))::text as amount
        from erp_payment_receipts r
        left join lateral (
          select sum(x.amount) as allocated from erp_payment_allocations x
           where x.tenant_id = r.tenant_id and x.receipt_id = r.id and x.removed_at is null
        ) a on true
       where r.tenant_id = ${this.tenantId} and r.currency_code = ${currency}
       group by r.customer_id
      having sum(r.amount - coalesce(a.allocated, 0)) > 0
    `.execute(this.db);
    return rows.map((row) => ({ customerId: row.customer_id, amount: trimDecimal(row.amount) }));
  }

  /** What a report over this range leaves out: drafts, and documents still waiting to post. */
  async leftOut(
    from: string | undefined,
    to: string,
  ): Promise<{ drafts: number; waiting: number }> {
    const { rows } = await sql<{ drafts: number; waiting: number }>`
      select
        (select count(*)::int from erp_journals j
          where j.tenant_id = ${this.tenantId} and j.status = 'draft'
            and (${from ?? null}::date is null or j.entry_date >= ${from ?? null}::date)
            and j.entry_date <= ${to}::date) as drafts,
        (select count(*)::int from erp_ledger_postings p
          where p.tenant_id = ${this.tenantId} and p.status = 'pending'
            and (${from ?? null}::date is null or p.document_date >= ${from ?? null}::date)
            and p.document_date <= ${to}::date) as waiting
    `.execute(this.db);
    return { drafts: rows[0]?.drafts ?? 0, waiting: rows[0]?.waiting ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Closed years
  // -------------------------------------------------------------------------

  /** Every close, newest year first; a reopened year keeps its record. */
  async yearCloses(): Promise<YearClose[]> {
    const rows = await this.db
      .selectFrom('erp_ledger_year_closes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .orderBy('year_start', 'desc')
      .orderBy('closed_at', 'desc')
      .execute();
    return rows.map(toYearClose);
  }

  /** The year's close in force, if it is closed. */
  async closeInForce(yearStart: string): Promise<YearClose | undefined> {
    const row = await this.db
      .selectFrom('erp_ledger_year_closes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('year_start', '=', yearStart)
      .where('reopened_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toYearClose(row);
  }

  async recordClose(
    yearStart: string,
    closingJournalId: string,
    by: UserId | string,
  ): Promise<YearClose> {
    const row = await this.db
      .insertInto('erp_ledger_year_closes')
      .values({
        tenant_id: this.tenantId,
        year_start: yearStart,
        closing_journal_id: closingJournalId,
        closed_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toYearClose(row);
  }

  async recordReopen(
    id: string,
    reopeningJournalId: string,
    by: UserId | string,
    reason: string,
  ): Promise<YearClose> {
    const row = await this.db
      .updateTable('erp_ledger_year_closes')
      .set({
        reopened_by: toUserId(by),
        reopened_at: sql<Date>`now()`,
        reopen_reason: reason,
        reopening_journal_id: reopeningJournalId,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('reopened_at', 'is', null)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toYearClose(row);
  }
}

function toYearClose(row: {
  id: string;
  year_start: string | Date;
  closing_journal_id: string;
  closed_by: string;
  closed_at: Date;
  reopened_by: string | null;
  reopened_at: Date | null;
  reopen_reason: string | null;
  reopening_journal_id: string | null;
}): YearClose {
  return {
    id: row.id,
    yearStart: toDayString(row.year_start) ?? '',
    closingJournalId: row.closing_journal_id,
    closedBy: toUserId(row.closed_by),
    closedAt: row.closed_at,
    reopenedBy: row.reopened_by === null ? null : toUserId(row.reopened_by),
    reopenedAt: row.reopened_at,
    reopenReason: row.reopen_reason,
    reopeningJournalId: row.reopening_journal_id,
  };
}
