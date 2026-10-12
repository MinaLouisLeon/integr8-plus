import {
  type AccountType,
  type JournalKind,
  type JournalSourceKind,
  type JournalStatus,
  type PeriodEventKind,
  POSTING_ROLES,
  type PostingRole,
  toUserId,
  type UserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  ErpJournalLinesTable,
  ErpJournalsTable,
  ErpLedgerAccountsTable,
  ErpLedgerPostingsTable,
  ErpLedgerSettingsTable,
  LedgerPostingReason,
  LedgerPostingStatus,
} from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * The general ledger (CRM/ERP plan, phase A1; ADR-0009).
 *
 * Journals are written as drafts and posted by changing their status; the
 * database checks a journal when it is posted (set up, dated on or after the
 * start, in an open month, balanced, accounts in use, approved by a second
 * person when written by hand) and refuses any change afterwards. Callers
 * check the same things first, so a refusal can be said in words and the
 * transaction stays usable; the database is the backstop.
 */

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  archivedAt: Date | null;
  archivedBy: UserId | null;
  version: number;
  createdAt: Date;
}

export type PostingAccounts = Record<PostingRole, string>;

export interface LedgerSettings {
  /** `YYYY-MM-01`. */
  startDate: string;
  fiscalStartMonth: number;
  autoPostSales: boolean;
  autoPostStock: boolean;
  allowSelfApproval: boolean;
  accounts: PostingAccounts;
  version: number;
  updatedAt: Date;
}

export interface Journal {
  id: string;
  reference: number | null;
  status: JournalStatus;
  kind: JournalKind;
  /** `YYYY-MM-DD`. */
  entryDate: string;
  memo: string | null;
  sourceKind: JournalSourceKind | null;
  sourceId: string | null;
  reversalOf: string | null;
  foreignCurrency: string | null;
  exchangeRate: string | null;
  rateSource: string | null;
  draftedBy: UserId;
  draftedAt: Date;
  postedBy: UserId | null;
  postedAt: Date | null;
  selfApproved: boolean;
}

export interface JournalLine {
  id: string;
  journalId: string;
  lineNo: number;
  accountId: string;
  /** Decimal string; `'0'` on a credit line. */
  debit: string;
  /** Decimal string; `'0'` on a debit line. */
  credit: string;
  memo: string | null;
  customerId: string | null;
  foreignAmount: string | null;
}

export interface JournalLineInput {
  accountId: string;
  debit?: string | undefined;
  credit?: string | undefined;
  memo?: string | null | undefined;
  customerId?: string | null | undefined;
  foreignAmount?: string | null | undefined;
}

export interface JournalDraftInput {
  kind: JournalKind;
  entryDate: string;
  memo?: string | null | undefined;
  sourceKind?: JournalSourceKind | undefined;
  sourceId?: string | undefined;
  reversalOf?: string | undefined;
  foreign?: { currency: string; rate: string; source: string } | undefined;
}

export interface PeriodState {
  /** `YYYY-MM-01`. */
  periodStart: string;
  locked: boolean;
  changedBy: UserId;
  changedAt: Date;
}

export interface PeriodEvent {
  id: string;
  periodStart: string;
  kind: PeriodEventKind;
  reason: string | null;
  actorId: UserId;
  occurredAt: Date;
}

/** A document captured for the ledger: posted, set aside, or waiting in the unposted list. */
export interface LedgerPosting {
  id: string;
  sourceKind: JournalSourceKind;
  sourceId: string;
  /** `YYYY-MM-DD`. */
  documentDate: string;
  currency: string;
  status: LedgerPostingStatus;
  reason: LedgerPostingReason | null;
  detail: string | null;
  journalId: string | null;
  resolvedBy: UserId | null;
  resolvedAt: Date | null;
  skipReason: string | null;
  capturedAt: Date;
  /** `INV-000012`, `CN-000003`, `RC-000004`; null for stock. */
  label: string | null;
  /** The proposal's debits, in the document's currency. */
  amount: string;
}

/** One line of the journal a document would post, in the document's currency. */
export interface ProposedLine {
  accountId: string;
  debit: string;
  credit: string;
  customerId: string | null;
}

export interface JournalQuery {
  status?: JournalStatus | undefined;
  kinds?: readonly JournalKind[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  accountId?: string | undefined;
  /** A journal number, or words in its memo. */
  text?: string | undefined;
  reference?: number | undefined;
  sourceKind?: JournalSourceKind | undefined;
  sourceId?: string | undefined;
  /** Newest first: the page after this journal. */
  before?: { date: string; key: string } | undefined;
  limit: number;
}

const ROLE_COLUMNS: Record<PostingRole, keyof ErpLedgerSettingsTable & `${string}_account_id`> = {
  receivables: 'receivables_account_id',
  revenueServices: 'revenue_services_account_id',
  revenueGoods: 'revenue_goods_account_id',
  vatOutput: 'vat_output_account_id',
  cash: 'cash_account_id',
  bank: 'bank_account_id',
  otherReceipts: 'other_receipts_account_id',
  inventory: 'inventory_account_id',
  goodsReceived: 'goods_received_account_id',
  partsCost: 'parts_cost_account_id',
  stockAdjustments: 'stock_adjustments_account_id',
  openingBalances: 'opening_balances_account_id',
  retainedEarnings: 'retained_earnings_account_id',
};

function toAccount(row: Selectable<ErpLedgerAccountsTable>): LedgerAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by === null ? null : toUserId(row.archived_by),
    version: row.version,
    createdAt: row.created_at,
  };
}

function toSettings(row: Selectable<ErpLedgerSettingsTable>): LedgerSettings {
  const accounts = {} as PostingAccounts;
  for (const role of POSTING_ROLES) {
    accounts[role] = row[ROLE_COLUMNS[role]];
  }
  return {
    startDate: toDayString(row.start_date) ?? '',
    fiscalStartMonth: row.fiscal_start_month,
    autoPostSales: row.auto_post_sales,
    autoPostStock: row.auto_post_stock,
    allowSelfApproval: row.allow_self_approval,
    accounts,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function toJournal(row: Selectable<ErpJournalsTable>): Journal {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    kind: row.kind,
    entryDate: toDayString(row.entry_date) ?? '',
    memo: row.memo,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    reversalOf: row.reversal_of,
    foreignCurrency: row.foreign_currency,
    exchangeRate: row.exchange_rate === null ? null : trimDecimal(row.exchange_rate),
    rateSource: row.rate_source,
    draftedBy: toUserId(row.drafted_by),
    draftedAt: row.drafted_at,
    postedBy: row.posted_by === null ? null : toUserId(row.posted_by),
    postedAt: row.posted_at,
    selfApproved: row.self_approved,
  };
}

function toLine(row: Selectable<ErpJournalLinesTable>): JournalLine {
  return {
    id: row.id,
    journalId: row.journal_id,
    lineNo: row.line_no,
    accountId: row.account_id,
    debit: trimDecimal(row.debit),
    credit: trimDecimal(row.credit),
    memo: row.memo,
    customerId: row.customer_id,
    foreignAmount: row.foreign_amount === null ? null : trimDecimal(row.foreign_amount),
  };
}

const isZero = (value: string | undefined) =>
  value === undefined || /^0*(\.0*)?$/u.test(value.trim());

export class LedgerRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Set-up and settings
  // -------------------------------------------------------------------------

  /** The ledger's settings, or undefined while it is not set up. */
  async settings(): Promise<LedgerSettings | undefined> {
    const row = await this.db
      .selectFrom('erp_ledger_settings')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSettings(row);
  }

  /**
   * Creates the chart and the settings in one go. The chart names an account
   * for every posting role; `already_set_up` when a ledger exists.
   */
  async setUp(
    input: {
      startDate: string;
      fiscalStartMonth: number;
      chart: readonly { code: string; name: string; type: AccountType; role?: PostingRole }[];
    },
    by: UserId | string,
  ): Promise<LedgerSettings | 'already_set_up'> {
    if ((await this.settings()) !== undefined) {
      return 'already_set_up';
    }
    const actor = toUserId(by);
    const rows = await this.db
      .insertInto('erp_ledger_accounts')
      .values(
        input.chart.map((account) => ({
          tenant_id: this.tenantId,
          code: account.code,
          name: account.name,
          type: account.type,
          created_by: actor,
        })),
      )
      .returning(['id', 'code'])
      .execute();
    const idOf = new Map(rows.map((row) => [row.code, row.id]));
    const roles = {} as Record<(typeof ROLE_COLUMNS)[PostingRole], string>;
    for (const role of POSTING_ROLES) {
      const account = input.chart.find((candidate) => candidate.role === role);
      const id = account === undefined ? undefined : idOf.get(account.code);
      if (id === undefined) {
        throw new Error(`The chart names no account for ${role}`);
      }
      roles[ROLE_COLUMNS[role]] = id;
    }
    const row = await this.db
      .insertInto('erp_ledger_settings')
      .values({
        tenant_id: this.tenantId,
        start_date: input.startDate,
        fiscal_start_month: input.fiscalStartMonth,
        created_by: actor,
        ...roles,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSettings(row);
  }

  async saveSettings(
    expectedVersion: number,
    changes: {
      startDate?: string | undefined;
      fiscalStartMonth?: number | undefined;
      autoPostSales?: boolean | undefined;
      autoPostStock?: boolean | undefined;
      allowSelfApproval?: boolean | undefined;
      accounts?: Partial<PostingAccounts> | undefined;
    },
    by: UserId | string,
  ): Promise<LedgerSettings | 'version_conflict'> {
    const roles: Partial<Record<(typeof ROLE_COLUMNS)[PostingRole], string>> = {};
    for (const [role, id] of Object.entries(changes.accounts ?? {}) as [PostingRole, string][]) {
      roles[ROLE_COLUMNS[role]] = id;
    }
    const row = await this.db
      .updateTable('erp_ledger_settings')
      .set({
        ...(changes.startDate === undefined ? {} : { start_date: changes.startDate }),
        ...(changes.fiscalStartMonth === undefined
          ? {}
          : { fiscal_start_month: changes.fiscalStartMonth }),
        ...(changes.autoPostSales === undefined ? {} : { auto_post_sales: changes.autoPostSales }),
        ...(changes.autoPostStock === undefined ? {} : { auto_post_stock: changes.autoPostStock }),
        ...(changes.allowSelfApproval === undefined
          ? {}
          : { allow_self_approval: changes.allowSelfApproval }),
        ...roles,
        version: sql<number>`version + 1`,
        updated_by: toUserId(by),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toSettings(row);
  }

  /** Whether anything has been posted: the start date and fiscal year are fixed from then on. */
  async anyPosted(): Promise<boolean> {
    const row = await this.db
      .selectFrom('erp_journals')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'posted')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async accounts(options: { includeArchived?: boolean } = {}): Promise<LedgerAccount[]> {
    let query = this.db
      .selectFrom('erp_ledger_accounts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (options.includeArchived !== true) {
      query = query.where('archived_at', 'is', null);
    }
    return (await query.orderBy('code').execute()).map(toAccount);
  }

  async account(id: string): Promise<LedgerAccount | undefined> {
    const row = await this.db
      .selectFrom('erp_ledger_accounts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  }

  async accountsByIds(ids: readonly string[]): Promise<Map<string, LedgerAccount>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('erp_ledger_accounts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(ids)])
      .execute();
    return new Map(rows.map((row) => [row.id, toAccount(row)]));
  }

  async accountByCode(code: string): Promise<LedgerAccount | undefined> {
    const row = await this.db
      .selectFrom('erp_ledger_accounts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('code', '=', code)
      .executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  }

  async createAccount(
    input: { code: string; name: string; type: AccountType },
    by: UserId | string,
  ): Promise<LedgerAccount | 'code_taken'> {
    if ((await this.accountByCode(input.code)) !== undefined) {
      return 'code_taken';
    }
    const row = await this.db
      .insertInto('erp_ledger_accounts')
      .values({
        tenant_id: this.tenantId,
        code: input.code,
        name: input.name.trim(),
        type: input.type,
        created_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAccount(row);
  }

  async updateAccount(
    id: string,
    expectedVersion: number,
    changes: {
      code?: string | undefined;
      name?: string | undefined;
      type?: AccountType | undefined;
      archived?: boolean | undefined;
    },
    by: UserId | string,
  ): Promise<LedgerAccount | 'version_conflict' | 'code_taken'> {
    if (changes.code !== undefined) {
      const holder = await this.accountByCode(changes.code);
      if (holder !== undefined && holder.id !== id) {
        return 'code_taken';
      }
    }
    const row = await this.db
      .updateTable('erp_ledger_accounts')
      .set({
        ...(changes.code === undefined ? {} : { code: changes.code }),
        ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
        ...(changes.type === undefined ? {} : { type: changes.type }),
        ...(changes.archived === undefined
          ? {}
          : changes.archived
            ? { archived_at: sql<Date>`now()`, archived_by: toUserId(by) }
            : { archived_at: null, archived_by: null }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toAccount(row);
  }

  /** Whether any posted journal line uses the account: its type is fixed from then on. */
  async accountUsed(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('erp_journal_lines as l')
      .innerJoin('erp_journals as j', (join) =>
        join.onRef('j.tenant_id', '=', 'l.tenant_id').onRef('j.id', '=', 'l.journal_id'),
      )
      .select('l.id')
      .where('l.tenant_id', '=', this.tenantId)
      .where('l.account_id', '=', id)
      .where('j.status', '=', 'posted')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Periods
  // -------------------------------------------------------------------------

  /** The months that have a lock state, in order. A month without one is open. */
  async periods(from?: string, to?: string): Promise<PeriodState[]> {
    let query = this.db
      .selectFrom('erp_ledger_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (from !== undefined) {
      query = query.where('period_start', '>=', from);
    }
    if (to !== undefined) {
      query = query.where('period_start', '<=', to);
    }
    const rows = await query.orderBy('period_start').execute();
    return rows.map((row) => ({
      periodStart: toDayString(row.period_start as unknown as string | Date) ?? '',
      locked: row.locked,
      changedBy: toUserId(row.changed_by),
      changedAt: row.changed_at,
    }));
  }

  async periodLocked(date: string): Promise<boolean> {
    const { rows } = await sql<{ locked: boolean }>`
      select erp_ledger_period_locked(${this.tenantId}::uuid, ${date}::date) as locked
    `.execute(this.db);
    return rows[0]?.locked === true;
  }

  /** Locks or unlocks a month, appending why. Unchanged when it already is. */
  async setPeriodLocked(
    periodStart: string,
    locked: boolean,
    by: UserId | string,
    reason: string | null,
  ): Promise<{ changed: boolean }> {
    const actor = toUserId(by);
    if ((await this.periodLocked(periodStart)) === locked) {
      return { changed: false };
    }
    await this.db
      .insertInto('erp_ledger_periods')
      .values({
        tenant_id: this.tenantId,
        period_start: periodStart,
        locked,
        changed_by: actor,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'period_start']).doUpdateSet({
          locked,
          changed_by: actor,
          changed_at: sql<Date>`now()`,
        }),
      )
      .execute();
    await this.db
      .insertInto('erp_ledger_period_events')
      .values({
        tenant_id: this.tenantId,
        period_start: periodStart,
        kind: locked ? 'locked' : 'unlocked',
        reason,
        actor_id: actor,
      })
      .execute();
    return { changed: true };
  }

  async periodEvents(periodStart?: string): Promise<PeriodEvent[]> {
    let query = this.db
      .selectFrom('erp_ledger_period_events')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (periodStart !== undefined) {
      query = query.where('period_start', '=', periodStart);
    }
    const rows = await query.orderBy('occurred_at', 'desc').limit(200).execute();
    return rows.map((row) => ({
      id: row.id,
      periodStart: toDayString(row.period_start as unknown as string | Date) ?? '',
      kind: row.kind,
      reason: row.reason,
      actorId: toUserId(row.actor_id),
      occurredAt: row.occurred_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Journals
  // -------------------------------------------------------------------------

  /** Writes a draft with its lines, numbered in order. */
  async createDraft(
    input: JournalDraftInput,
    lines: readonly JournalLineInput[],
    by: UserId | string,
  ): Promise<Journal> {
    const row = await this.db
      .insertInto('erp_journals')
      .values({
        tenant_id: this.tenantId,
        kind: input.kind,
        entry_date: input.entryDate,
        memo: input.memo ?? null,
        source_kind: input.sourceKind ?? null,
        source_id: input.sourceId ?? null,
        reversal_of: input.reversalOf ?? null,
        foreign_currency: input.foreign?.currency ?? null,
        exchange_rate: input.foreign?.rate ?? null,
        rate_source: input.foreign?.source ?? null,
        drafted_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.insertLines(row.id, lines);
    return toJournal(row);
  }

  private async insertLines(journalId: string, lines: readonly JournalLineInput[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('erp_journal_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: this.tenantId,
          journal_id: journalId,
          line_no: index + 1,
          account_id: line.accountId,
          debit: isZero(line.debit) ? '0' : (line.debit ?? '0'),
          credit: isZero(line.credit) ? '0' : (line.credit ?? '0'),
          memo: line.memo ?? null,
          customer_id: line.customerId ?? null,
          foreign_amount: line.foreignAmount ?? null,
        })),
      )
      .execute();
  }

  /** Rewrites a draft's date, memo and lines. Undefined when it is not a draft. */
  async replaceDraft(
    id: string,
    changes: { entryDate: string; memo: string | null },
    lines: readonly JournalLineInput[],
    by: UserId | string,
  ): Promise<Journal | undefined> {
    // Whoever rewrites a draft becomes its drafter: the approver must be someone else.
    const row = await this.db
      .updateTable('erp_journals')
      .set({
        entry_date: changes.entryDate,
        memo: changes.memo,
        drafted_by: toUserId(by),
        drafted_at: sql<Date>`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    await this.db
      .deleteFrom('erp_journal_lines')
      .where('tenant_id', '=', this.tenantId)
      .where('journal_id', '=', id)
      .execute();
    await this.insertLines(id, lines);
    return toJournal(row);
  }

  /** Deletes a draft and its lines. False when it is not a draft. */
  async discardDraft(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('erp_journals')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Posts a draft: the database numbers it and checks everything. */
  async post(id: string, by: UserId | string, selfApproved = false): Promise<Journal> {
    const row = await this.db
      .updateTable('erp_journals')
      .set({
        status: 'posted',
        posted_by: toUserId(by),
        posted_at: sql<Date>`now()`,
        self_approved: selfApproved,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirstOrThrow();
    return toJournal(row);
  }

  async find(id: string): Promise<Journal | undefined> {
    const row = await this.db
      .selectFrom('erp_journals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toJournal(row);
  }

  /** Locks the journal row for the rest of the transaction. */
  async lock(id: string): Promise<Journal | undefined> {
    const row = await this.db
      .selectFrom('erp_journals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toJournal(row);
  }

  async findBySource(
    sourceKind: JournalSourceKind,
    sourceId: string,
  ): Promise<Journal | undefined> {
    const row = await this.db
      .selectFrom('erp_journals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('source_kind', '=', sourceKind)
      .where('source_id', '=', sourceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toJournal(row);
  }

  /** The journal that reverses this one, if any. */
  async reversalFor(id: string): Promise<Journal | undefined> {
    const row = await this.db
      .selectFrom('erp_journals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('reversal_of', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toJournal(row);
  }

  async openingJournal(): Promise<Journal | undefined> {
    const row = await this.db
      .selectFrom('erp_journals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('kind', '=', 'opening')
      .executeTakeFirst();
    return row === undefined ? undefined : toJournal(row);
  }

  async lines(journalId: string): Promise<JournalLine[]> {
    const rows = await this.db
      .selectFrom('erp_journal_lines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('journal_id', '=', journalId)
      .orderBy('line_no')
      .execute();
    return rows.map(toLine);
  }

  async linesOf(journalIds: readonly string[]): Promise<Map<string, JournalLine[]>> {
    const result = new Map<string, JournalLine[]>();
    if (journalIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .selectFrom('erp_journal_lines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('journal_id', 'in', [...new Set(journalIds)])
      .orderBy('journal_id')
      .orderBy('line_no')
      .execute();
    for (const row of rows) {
      const list = result.get(row.journal_id) ?? [];
      list.push(toLine(row));
      result.set(row.journal_id, list);
    }
    return result;
  }

  /** Journals, newest first: posted by date and number, drafts by when written. */
  async list(
    query: JournalQuery,
  ): Promise<{ items: Journal[]; next?: { date: string; key: string } }> {
    let select = this.db
      .selectFrom('erp_journals as j')
      .selectAll('j')
      .where('j.tenant_id', '=', this.tenantId);
    if (query.status !== undefined) {
      select = select.where('j.status', '=', query.status);
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      select = select.where('j.kind', 'in', [...query.kinds]);
    }
    if (query.from !== undefined) {
      select = select.where('j.entry_date', '>=', query.from);
    }
    if (query.to !== undefined) {
      select = select.where('j.entry_date', '<=', query.to);
    }
    if (query.sourceKind !== undefined) {
      select = select.where('j.source_kind', '=', query.sourceKind);
    }
    if (query.sourceId !== undefined) {
      select = select.where('j.source_id', '=', query.sourceId);
    }
    if (query.accountId !== undefined) {
      const accountId = query.accountId;
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom('erp_journal_lines as l')
            .select('l.id')
            .whereRef('l.tenant_id', '=', 'j.tenant_id')
            .whereRef('l.journal_id', '=', 'j.id')
            .where('l.account_id', '=', accountId),
        ),
      );
    }
    if (query.reference !== undefined) {
      select = select.where('j.reference', '=', query.reference);
    } else if (query.text !== undefined && query.text.trim() !== '') {
      const words = `%${query.text.trim().replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      select = select.where('j.memo', 'ilike', words);
    }
    // One sort key for both: the date, then the number (drafts sort after, by id).
    const key = sql<string>`coalesce(lpad(j.reference::text, 12, '0'), 'z' || j.id::text)`;
    if (query.before !== undefined) {
      const { date, key: beforeKey } = query.before;
      select = select.where(sql<boolean>`(j.entry_date, ${key}) < (${date}::date, ${beforeKey})`);
    }
    const rows = await select
      .select(key.as('sort_key'))
      .orderBy('j.entry_date', 'desc')
      .orderBy(key, 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toJournal(row)),
      ...(rows.length > query.limit && last !== undefined
        ? {
            next: {
              date: toDayString(last.entry_date) ?? '',
              key: (last as unknown as { sort_key: string }).sort_key,
            },
          }
        : {}),
    };
  }

  /**
   * What each customer owed at the start of `date`, in `currency`, as the
   * ledger's receivables would hold it: invoices issued before it (and not
   * voided before it), less credit notes issued before it, less payments
   * received before it. For the opening journal; customers at zero are left out.
   */
  async receivablesAt(
    date: string,
    currency: string,
  ): Promise<{ customerId: string; amount: string }[]> {
    const { rows } = await sql<{ customer_id: string; amount: string }>`
      select customer_id, sum(amount)::text as amount from (
        select i.customer_id, erp_invoice_total(i.tenant_id, i.id) as amount
          from erp_invoices i
         where i.tenant_id = ${this.tenantId} and i.currency_code = ${currency}
           and i.status <> 'draft' and i.issue_date < ${date}::date
           and (i.status <> 'void' or i.voided_at >= ${date}::date)
        union all
        select i.customer_id, -erp_credit_note_total(c.tenant_id, c.id)
          from erp_credit_notes c
          join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
         where c.tenant_id = ${this.tenantId} and i.currency_code = ${currency}
           and c.status = 'issued' and c.issue_date < ${date}::date
        union all
        select r.customer_id, -r.amount
          from erp_payment_receipts r
         where r.tenant_id = ${this.tenantId} and r.currency_code = ${currency}
           and r.received_on < ${date}::date
      ) owed
      group by customer_id
      having sum(amount) <> 0
      order by customer_id
    `.execute(this.db);
    return rows.map((row) => ({ customerId: row.customer_id, amount: trimDecimal(row.amount) }));
  }

  // -------------------------------------------------------------------------
  // Documents captured for posting (0034)
  // -------------------------------------------------------------------------

  private postingQuery() {
    return this.db
      .selectFrom('erp_ledger_postings as p')
      .selectAll('p')
      .select([
        sql<string | null>`erp_ledger_source_label(p.tenant_id, p.source_kind, p.source_id)`.as(
          'label',
        ),
        sql<string>`coalesce((select sum(x.debit) from erp_ledger_proposal(p.tenant_id, p.source_kind, p.source_id) x), 0)::text`.as(
          'amount',
        ),
      ])
      .where('p.tenant_id', '=', this.tenantId);
  }

  private toPosting(
    row: Selectable<ErpLedgerPostingsTable> & { label: string | null; amount: string },
  ): LedgerPosting {
    return {
      id: row.id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      documentDate: toDayString(row.document_date) ?? '',
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      detail: row.detail,
      journalId: row.journal_id,
      resolvedBy: row.resolved_by === null ? null : toUserId(row.resolved_by),
      resolvedAt: row.resolved_at,
      skipReason: row.skip_reason,
      capturedAt: row.captured_at,
      label: row.label,
      amount: trimDecimal(row.amount),
    };
  }

  /** Captured documents, oldest first: the unposted list reads in the order things happened. */
  async postings(query: {
    status?: LedgerPostingStatus | undefined;
    kinds?: readonly JournalSourceKind[] | undefined;
    reasons?: readonly LedgerPostingReason[] | undefined;
    after?: { date: string; id: string } | undefined;
    limit: number;
  }): Promise<{ items: LedgerPosting[]; next?: { date: string; id: string } }> {
    let select = this.postingQuery();
    if (query.status !== undefined) {
      select = select.where('p.status', '=', query.status);
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      select = select.where('p.source_kind', 'in', [...query.kinds]);
    }
    if (query.reasons !== undefined && query.reasons.length > 0) {
      select = select.where('p.reason', 'in', [...query.reasons]);
    }
    if (query.after !== undefined) {
      const { date, id } = query.after;
      select = select.where(sql<boolean>`(p.document_date, p.id) > (${date}::date, ${id}::uuid)`);
    }
    const rows = await select
      .orderBy('p.document_date')
      .orderBy('p.id')
      .limit(query.limit + 1)
      .execute();
    const items = rows.slice(0, query.limit).map((row) => this.toPosting(row));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { date: last.documentDate, id: last.id } }
        : {}),
    };
  }

  async posting(id: string): Promise<LedgerPosting | undefined> {
    const row = await this.postingQuery().where('p.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : this.toPosting(row);
  }

  async postingBySource(
    kind: JournalSourceKind,
    sourceId: string,
  ): Promise<LedgerPosting | undefined> {
    const row = await this.postingQuery()
      .where('p.source_kind', '=', kind)
      .where('p.source_id', '=', sourceId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.toPosting(row);
  }

  /** Locks a captured document for the rest of the transaction. */
  async lockPosting(id: string): Promise<LedgerPosting | undefined> {
    await this.db
      .selectFrom('erp_ledger_postings')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return this.posting(id);
  }

  /** How many documents wait, by why. */
  async pendingCounts(): Promise<Partial<Record<LedgerPostingReason, number>>> {
    const rows = await this.db
      .selectFrom('erp_ledger_postings')
      .select(['reason', sql<number>`count(*)::int`.as('n')])
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'pending')
      .groupBy('reason')
      .execute();
    const counts: Partial<Record<LedgerPostingReason, number>> = {};
    for (const row of rows) {
      if (row.reason !== null) {
        counts[row.reason] = row.n;
      }
    }
    return counts;
  }

  /** The journal a document would post, in its own currency. */
  async proposal(kind: JournalSourceKind, sourceId: string): Promise<ProposedLine[]> {
    const { rows } = await sql<{
      account_id: string;
      debit: string;
      credit: string;
      customer_id: string | null;
    }>`
      select x.account_id, x.debit::text as debit, x.credit::text as credit, x.customer_id
        from erp_ledger_proposal(${this.tenantId}::uuid, ${kind}, ${sourceId}::uuid)
             with ordinality as x(account_id, debit, credit, customer_id, n)
       order by x.n
    `.execute(this.db);
    return rows.map((row) => ({
      accountId: row.account_id,
      debit: trimDecimal(row.debit),
      credit: trimDecimal(row.credit),
      customerId: row.customer_id,
    }));
  }

  /**
   * Posts a waiting document as its proposal says, or records why it still
   * waits. `force` ignores the company's switch, as the accountant's "post"
   * does. Returns `posted`, `skipped`, or the reason it waits.
   */
  async tryPost(postingId: string, by: UserId | string, force: boolean): Promise<string> {
    const { rows } = await sql<{ outcome: string }>`
      select erp_ledger_try_post(${postingId}::uuid, ${toUserId(by)}::uuid, ${force}) as outcome
    `.execute(this.db);
    return rows[0]?.outcome ?? 'missing';
  }

  /** Queues documents recorded on or after the start for review; returns how many joined. */
  async backfill(): Promise<number> {
    const { rows } = await sql<{ added: number }>`
      select erp_ledger_backfill(${this.tenantId}::uuid) as added
    `.execute(this.db);
    return rows[0]?.added ?? 0;
  }

  /** Marks a waiting document posted by a journal the caller wrote. */
  async markPosted(postingId: string, journalId: string, by: UserId | string): Promise<void> {
    await this.db
      .updateTable('erp_ledger_postings')
      .set({
        status: 'posted',
        journal_id: journalId,
        reason: null,
        detail: null,
        resolved_by: toUserId(by),
        resolved_at: sql<Date>`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', postingId)
      .where('status', '=', 'pending')
      .execute();
  }

  /** Sets a waiting document aside: it will never post. */
  async skip(postingId: string, by: UserId | string, reason: string): Promise<boolean> {
    const result = await this.db
      .updateTable('erp_ledger_postings')
      .set({
        status: 'skipped',
        reason: null,
        detail: null,
        skip_reason: reason,
        resolved_by: toUserId(by),
        resolved_at: sql<Date>`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', postingId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** The invoice a credit note or a void follows; undefined for anything else. */
  async parentInvoiceOf(posting: LedgerPosting): Promise<LedgerPosting | undefined> {
    const { rows } = await sql<{ parent: string | null }>`
      select erp_ledger_parent_invoice(${this.tenantId}::uuid, ${posting.sourceKind}, ${posting.sourceId}::uuid) as parent
    `.execute(this.db);
    const parent = rows[0]?.parent ?? null;
    return parent === null ? undefined : this.postingBySource('invoice', parent);
  }

  /** Where these documents stand, without their amounts. */
  async postingStates(
    ids: readonly string[],
  ): Promise<Map<string, { status: LedgerPostingStatus; reason: LedgerPostingReason | null }>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('erp_ledger_postings')
      .select(['id', 'status', 'reason'])
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((row) => [row.id, { status: row.status, reason: row.reason }]));
  }

  /** Waiting credit notes and voids that follow this invoice. */
  async pendingFollowing(invoiceId: string): Promise<LedgerPosting[]> {
    const rows = await this.postingQuery()
      .where('p.status', '=', 'pending')
      .where('p.source_kind', 'in', ['credit_note', 'invoice_void'])
      .where(
        sql<boolean>`erp_ledger_parent_invoice(p.tenant_id, p.source_kind, p.source_id) = ${invoiceId}::uuid`,
      )
      .orderBy('p.document_date')
      .orderBy('p.id')
      .execute();
    return rows.map((row) => this.toPosting(row));
  }

  /** Customers named on lines, for showing receivables lines. */
  async customersOnLines(journalIds: readonly string[]): Promise<string[]> {
    if (journalIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_journal_lines')
      .select('customer_id')
      .distinct()
      .where('tenant_id', '=', this.tenantId)
      .where('journal_id', 'in', [...journalIds])
      .where('customer_id', 'is not', null)
      .execute();
    return rows.flatMap((row) => (row.customer_id === null ? [] : [row.customer_id]));
  }
}
