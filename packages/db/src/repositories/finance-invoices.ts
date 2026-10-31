import {
  type CreditNoteStatus,
  type InvoiceStoredStatus,
  type UserId,
  parseFinanceReference,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpCreditNotesTable, ErpFinanceSettingsTable, ErpInvoicesTable } from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import type { Address } from './customers.js';
import { prefixQuery } from './customers.js';
import {
  blankToNull,
  type DocumentTotals,
  documentTotals,
  LINE_MATH,
  type LineRow,
  type QuoteLine,
  type QuoteLineInput,
  toAddress,
  toLine,
} from './sales-quotes.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * A company's invoices and credit notes (CRM/ERP plan, phase B1; ADR-0004,
 * ADR-0007).
 *
 * The company's own commercial ledger, not Integr8's billing. A draft is
 * edited freely; issuing numbers it (`INV-000001`…, by trigger) and copies
 * the customer and the issuer onto it, and from then on the database refuses
 * any change but a void while nothing is paid or credited against it
 * (`erp_invoices_guard`). A credit note reduces an issued invoice by no more
 * than it still owes (`erp_credit_notes_guard`). Every figure is computed in
 * SQL from the lines; an invoice's balance and status follow from the facts.
 */

export interface FinanceSettings {
  legalName: string | null;
  address: string | null;
  taxReference: string | null;
  paymentInstructions: string | null;
  footer: string | null;
  defaultDueDays: number;
  /** What an hour of a job costs the company; null when not set. */
  labourHourlyCost: string | null;
  /** What the company charges for an hour; the price of a job invoice's labour line. */
  labourHourlyRate: string | null;
  /** 0 until saved for the first time. */
  version: number;
  updatedBy: UserId | null;
  updatedAt: Date | null;
}

export type FinanceSettingsInput = {
  [K in keyof Omit<FinanceSettings, 'version' | 'updatedBy' | 'updatedAt'>]?:
    FinanceSettings[K] | undefined;
};

/** The company as an issued invoice names it. */
export interface IssuerSnapshot {
  name: string;
  address: string | null;
  taxReference: string | null;
  paymentInstructions: string | null;
  footer: string | null;
}

export interface Invoice {
  id: string;
  /** Null while a draft. */
  reference: number | null;
  customerId: string;
  siteId: string | null;
  contactId: string | null;
  salesOrderId: string | null;
  workOrderId: string | null;
  status: InvoiceStoredStatus;
  currencyCode: string;
  /** `YYYY-MM-DD`. */
  issueDate: string | null;
  dueDate: string | null;
  notes: string | null;
  internalNotes: string | null;
  customerName: string | null;
  customerAddress: Address | null;
  contactName: string | null;
  contactEmail: string | null;
  issuer: IssuerSnapshot | null;
  issuedBy: UserId | null;
  issuedAt: Date | null;
  voidedBy: UserId | null;
  voidedAt: Date | null;
  voidReason: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceLine extends QuoteLine {
  salesOrderLineId: string | null;
  workOrderMaterialId: string | null;
}

export interface InvoiceLineInput extends QuoteLineInput {
  salesOrderLineId?: string | null;
  workOrderMaterialId?: string | null;
}

/** What an invoice adds up to and what it still owes. */
export interface InvoiceAmounts {
  total: string;
  /** Payments allocated to it. */
  allocated: string;
  /** Issued credit notes against it. */
  credited: string;
  /** `total − allocated − credited`. */
  balance: string;
}

export interface InvoiceInput {
  customerId: string;
  siteId?: string | null;
  contactId?: string | null;
  salesOrderId?: string | null;
  workOrderId?: string | null;
  currencyCode: string;
  dueDate?: string | null;
  notes?: string | null;
  internalNotes?: string | null;
}

export interface InvoiceQuery {
  /** A reference such as `INV-000123`, or words of the customer's name. */
  text?: string;
  /** Derived statuses: `paid` and the rest are worked out from the balance. */
  statuses?: readonly string[];
  customerId?: string;
  salesOrderId?: string;
  workOrderId?: string;
  /** Issued, still owing, and past its due date as of `today`. */
  overdue?: { today: string };
  after?: { createdAt: Date; id: string };
  limit?: number;
}

export interface InvoicePage {
  items: Invoice[];
  next: { createdAt: Date; id: string } | undefined;
}

export interface ReceivablesSummary {
  /** Issued invoices with something still owing, partly paid ones included. */
  unpaid: number;
  /** Of those, past their due date. */
  overdue: number;
  /** What is owed, and what of it is overdue, per currency. */
  owing: { currency: string; amount: string; overdue: string }[];
  /** How many customers owe anything. */
  customersOwing: number;
  /** The customers owing most, per currency, largest first. */
  byCustomer: {
    customerId: string;
    customer: string;
    currency: string;
    invoices: number;
    amount: string;
  }[];
  /** The overdue invoices longest past their due date, oldest first. */
  oldestOverdue: {
    reference: number | null;
    customer: string;
    dueDate: string;
    currency: string;
    balance: string;
  }[];
}

export type InvoiceRefusal = 'not_found' | 'version_conflict';

export interface CreditNote {
  id: string;
  reference: number | null;
  invoiceId: string;
  status: CreditNoteStatus;
  reason: string;
  issueDate: string | null;
  issuedBy: UserId | null;
  issuedAt: Date | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreditNoteLine extends QuoteLine {
  invoiceLineId: string | null;
}

export interface CreditNoteLineInput extends QuoteLineInput {
  invoiceLineId?: string | null;
}

/** Why the database refused to issue a credit note. */
export type CreditNoteIssueRefusal = 'over_balance' | 'empty' | 'invoice_not_open';

interface InvoiceLineRow extends LineRow {
  sales_order_line_id: string | null;
  work_order_material_id: string | null;
}

interface CreditNoteLineRow extends LineRow {
  invoice_line_id: string | null;
}

/** The SQL that derives an invoice's status from its stored status and amounts. */
const DERIVED_STATUS = sql<string>`case
  when i.status <> 'issued' then i.status
  when a.balance <= 0 then case when a.allocated > 0 then 'paid' else 'credited' end
  when a.allocated > 0 then 'partially_paid'
  else 'issued' end`;

/** Each invoice's amounts, as a lateral subquery over `i`. */
const AMOUNTS = sql`lateral (
  select t.total,
         t.allocated,
         t.credited,
         t.total - t.allocated - t.credited as balance
    from (select erp_invoice_total(i.tenant_id, i.id) as total,
                 coalesce((select sum(pa.amount) from erp_payment_allocations pa
                            where pa.tenant_id = i.tenant_id and pa.invoice_id = i.id
                              and pa.removed_at is null), 0) as allocated,
                 coalesce((select sum(erp_credit_note_total(cn.tenant_id, cn.id)) from erp_credit_notes cn
                            where cn.tenant_id = i.tenant_id and cn.invoice_id = i.id
                              and cn.status = 'issued'), 0) as credited) t
) a`;

export class FinanceInvoicesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async settings(): Promise<FinanceSettings> {
    const row = await this.db
      .selectFrom('erp_finance_settings')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row === undefined ? DEFAULT_FINANCE_SETTINGS : toSettings(row);
  }

  /** Saves the settings; `expectedVersion` 0 creates them. */
  async saveSettings(
    input: FinanceSettingsInput,
    expectedVersion: number,
    actor: UserId | string,
  ): Promise<FinanceSettings | 'version_conflict'> {
    const values = {
      ...(input.legalName === undefined ? {} : { legal_name: blankToNull(input.legalName) }),
      ...(input.address === undefined ? {} : { address: blankToNull(input.address) }),
      ...(input.taxReference === undefined
        ? {}
        : { tax_reference: blankToNull(input.taxReference) }),
      ...(input.paymentInstructions === undefined
        ? {}
        : { payment_instructions: blankToNull(input.paymentInstructions) }),
      ...(input.footer === undefined ? {} : { footer: blankToNull(input.footer) }),
      ...(input.defaultDueDays === undefined ? {} : { default_due_days: input.defaultDueDays }),
      ...(input.labourHourlyCost === undefined
        ? {}
        : { labour_hourly_cost: input.labourHourlyCost }),
      ...(input.labourHourlyRate === undefined
        ? {}
        : { labour_hourly_rate: input.labourHourlyRate }),
      updated_by: toUserId(actor),
    };
    if (expectedVersion === 0) {
      const row = await this.db
        .insertInto('erp_finance_settings')
        .values({ tenant_id: this.tenantId, ...values })
        .onConflict((oc) => oc.column('tenant_id').doNothing())
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? 'version_conflict' : toSettings(row);
    }
    const row = await this.db
      .updateTable('erp_finance_settings')
      .set({ ...values, version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toSettings(row);
  }

  // -------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------

  async createInvoice(
    input: InvoiceInput,
    lines: readonly InvoiceLineInput[],
    createdBy: UserId | string,
  ): Promise<Invoice> {
    const row = await this.db
      .insertInto('erp_invoices')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        customer_id: input.customerId,
        site_id: input.siteId ?? null,
        contact_id: input.contactId ?? null,
        sales_order_id: input.salesOrderId ?? null,
        work_order_id: input.workOrderId ?? null,
        currency_code: input.currencyCode,
        due_date: input.dueDate ?? null,
        notes: blankToNull(input.notes),
        internal_notes: blankToNull(input.internalNotes),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#writeInvoiceLines(row.id, lines);
    return toInvoice(row);
  }

  async findInvoice(invoiceId: string): Promise<Invoice | undefined> {
    const row = await this.db
      .selectFrom('erp_invoices')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invoiceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toInvoice(row);
  }

  /** Locks the invoice for the rest of the transaction: issuing, voiding and crediting wait for each other. */
  async lockInvoice(invoiceId: string): Promise<Invoice | undefined> {
    const row = await this.db
      .selectFrom('erp_invoices')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invoiceId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toInvoice(row);
  }

  async findInvoices(invoiceIds: readonly string[]): Promise<Invoice[]> {
    if (invoiceIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_invoices')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(invoiceIds)])
      .execute();
    return rows.map(toInvoice);
  }

  async listInvoices(query: InvoiceQuery = {}): Promise<InvoicePage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const filters = [sql`i.tenant_id = ${this.tenantId}`];
    if (query.text !== undefined && query.text.trim() !== '') {
      const reference = parseFinanceReference(query.text);
      if (reference !== undefined) {
        filters.push(sql`i.reference = ${reference}`);
      } else {
        const words = prefixQuery(query.text);
        if (words !== undefined) {
          filters.push(sql`(
            to_tsvector('simple', coalesce(i.customer_name, '')) @@ to_tsquery('simple', ${words})
            or exists (select 1 from customers c
                        where c.tenant_id = i.tenant_id and c.id = i.customer_id
                          and c.search @@ to_tsquery('simple', ${words})))`);
        }
      }
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      filters.push(
        sql`${DERIVED_STATUS} in (${sql.join(query.statuses.map((status) => sql`${status}`))})`,
      );
    }
    if (query.customerId !== undefined) {
      filters.push(sql`i.customer_id = ${query.customerId}::uuid`);
    }
    if (query.salesOrderId !== undefined) {
      filters.push(sql`i.sales_order_id = ${query.salesOrderId}::uuid`);
    }
    if (query.workOrderId !== undefined) {
      filters.push(sql`i.work_order_id = ${query.workOrderId}::uuid`);
    }
    if (query.overdue !== undefined) {
      filters.push(
        sql`i.status = 'issued' and a.balance > 0 and i.due_date < ${query.overdue.today}::date`,
      );
    }
    if (query.after !== undefined) {
      filters.push(sql`(i.created_at, i.id) < (${query.after.createdAt}, ${query.after.id}::uuid)`);
    }
    // Written as text, table and tenant predicate both, as the balance queries
    // are: the tenant guard reads Kysely nodes.
    const { rows } = await sql<Selectable<ErpInvoicesTable>>`
      select i.*
        from erp_invoices i, ${AMOUNTS}
       where ${sql.join(filters, sql` and `)}
       order by i.created_at desc, i.id desc
       limit ${limit + 1}
    `.execute(this.db);
    const items = rows.slice(0, limit).map(toInvoice);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }

  async invoiceLines(invoiceId: string): Promise<InvoiceLine[]> {
    const { rows } = await sql<InvoiceLineRow>`
      select l.*, ${LINE_MATH}
        from erp_invoice_lines l
       where l.tenant_id = ${this.tenantId} and l.invoice_id = ${invoiceId}
       order by l.position
    `.execute(this.db);
    return rows.map((row) => ({
      ...toLine(row),
      salesOrderLineId: row.sales_order_line_id,
      workOrderMaterialId: row.work_order_material_id,
    }));
  }

  async invoiceTotals(invoiceId: string): Promise<DocumentTotals> {
    return documentTotals(this.db, 'erp_invoice_lines', 'invoice_id', this.tenantId, invoiceId);
  }

  /**
   * What customers owe, exactly: counted and summed in the database over every
   * issued invoice with a balance, however many there are. The assistant's
   * figures come from here; a page of the newest invoices would leave out the
   * old debts, which are the ones that matter.
   */
  async receivablesSummary(query: {
    today: string;
    customerId?: string;
    customersLimit?: number;
    oldestLimit?: number;
  }): Promise<ReceivablesSummary> {
    const customerLimit = Math.min(Math.max(query.customersLimit ?? 10, 1), 50);
    const oldestLimit = Math.min(Math.max(query.oldestLimit ?? 10, 1), 50);
    const filters = [sql`i.tenant_id = ${this.tenantId}`, sql`i.status = 'issued'`];
    if (query.customerId !== undefined) {
      filters.push(sql`i.customer_id = ${query.customerId}::uuid`);
    }
    // Written as text with the tenant predicate in it, as the other balance
    // queries are: the tenant guard reads Kysely nodes.
    const owed = sql`owed as (
      select i.id, i.reference, i.customer_id, i.currency_code,
             coalesce(i.customer_name, '') as customer_name,
             i.due_date, a.balance,
             (i.due_date is not null and i.due_date < ${query.today}::date) as is_overdue
        from erp_invoices i, ${AMOUNTS}
       where ${sql.join(filters, sql` and `)} and a.balance > 0
    )`;

    const { rows: totals } = await sql<{
      currency: string;
      unpaid: string;
      overdue: string;
      amount: string;
      overdue_amount: string;
    }>`
      with ${owed}
      select currency_code as currency, count(*)::text as unpaid,
             count(*) filter (where is_overdue)::text as overdue,
             sum(balance)::text as amount,
             coalesce(sum(balance) filter (where is_overdue), 0)::text as overdue_amount
        from owed
       group by currency_code
       order by currency_code
    `.execute(this.db);

    const { rows: customers } = await sql<{
      customer_id: string;
      customer: string;
      currency: string;
      invoices: string;
      amount: string;
      owing_customers: string;
    }>`
      with ${owed}
      select customer_id, max(customer_name) as customer, currency_code as currency,
             count(*)::text as invoices, sum(balance)::text as amount,
             (select count(distinct customer_id) from owed)::text as owing_customers
        from owed
       group by customer_id, currency_code
       order by sum(balance) desc, customer_id
       limit ${customerLimit}
    `.execute(this.db);

    const { rows: oldest } = await sql<{
      reference: number | null;
      customer: string;
      due_date: string;
      currency: string;
      balance: string;
    }>`
      with ${owed}
      select reference, customer_name as customer, to_char(due_date, 'YYYY-MM-DD') as due_date,
             currency_code as currency, balance::text as balance
        from owed
       where is_overdue
       order by due_date, reference nulls last, id
       limit ${oldestLimit}
    `.execute(this.db);

    return {
      unpaid: totals.reduce((sum, row) => sum + Number(row.unpaid), 0),
      overdue: totals.reduce((sum, row) => sum + Number(row.overdue), 0),
      owing: totals.map((row) => ({
        currency: row.currency,
        amount: trimDecimal(row.amount),
        overdue: trimDecimal(row.overdue_amount),
      })),
      customersOwing: Number(customers[0]?.owing_customers ?? 0),
      byCustomer: customers.map((row) => ({
        customerId: row.customer_id,
        customer: row.customer,
        currency: row.currency,
        invoices: Number(row.invoices),
        amount: trimDecimal(row.amount),
      })),
      oldestOverdue: oldest.map((row) => ({
        reference: row.reference,
        customer: row.customer,
        dueDate: row.due_date,
        currency: row.currency,
        balance: trimDecimal(row.balance),
      })),
    };
  }

  /** Each invoice's total, what was allocated and credited, and what it still owes. */
  async invoiceAmounts(invoiceIds: readonly string[]): Promise<Map<string, InvoiceAmounts>> {
    if (invoiceIds.length === 0) {
      return new Map();
    }
    const ids = [...new Set(invoiceIds)];
    const { rows } = await sql<{
      id: string;
      total: string;
      allocated: string;
      credited: string;
      balance: string;
    }>`
      select i.id, a.total::text as total, a.allocated::text as allocated,
             a.credited::text as credited, a.balance::text as balance
        from erp_invoices i, ${AMOUNTS}
       where i.tenant_id = ${this.tenantId}
         and i.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
    `.execute(this.db);
    return new Map(
      rows.map((row) => [
        row.id,
        {
          total: trimDecimal(row.total),
          allocated: trimDecimal(row.allocated),
          credited: trimDecimal(row.credited),
          balance: trimDecimal(row.balance),
        },
      ]),
    );
  }

  /** Changes a draft, replacing every line when `lines` is given. */
  async updateDraft(
    invoiceId: string,
    expectedVersion: number,
    input: Partial<Omit<InvoiceInput, 'currencyCode' | 'salesOrderId' | 'workOrderId'>>,
    lines: readonly InvoiceLineInput[] | undefined,
  ): Promise<Invoice | InvoiceRefusal | 'not_draft'> {
    const current = await this.lockInvoice(invoiceId);
    if (current === undefined) {
      return 'not_found';
    }
    if (current.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.status !== 'draft') {
      return 'not_draft';
    }
    if (lines !== undefined) {
      await this.db
        .deleteFrom('erp_invoice_lines')
        .where('tenant_id', '=', this.tenantId)
        .where('invoice_id', '=', invoiceId)
        .execute();
      await this.#writeInvoiceLines(invoiceId, lines);
    }
    const row = await this.db
      .updateTable('erp_invoices')
      .set({
        ...(input.customerId === undefined ? {} : { customer_id: input.customerId }),
        ...(input.siteId === undefined ? {} : { site_id: input.siteId }),
        ...(input.contactId === undefined ? {} : { contact_id: input.contactId }),
        ...(input.dueDate === undefined ? {} : { due_date: input.dueDate }),
        ...(input.notes === undefined ? {} : { notes: blankToNull(input.notes) }),
        ...(input.internalNotes === undefined
          ? {}
          : { internal_notes: blankToNull(input.internalNotes) }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invoiceId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toInvoice(row);
  }

  /** Discards a draft and its lines; an issued invoice is never deleted. */
  async discardDraft(
    invoiceId: string,
    expectedVersion: number,
  ): Promise<true | InvoiceRefusal | 'not_draft'> {
    const current = await this.lockInvoice(invoiceId);
    if (current === undefined) {
      return 'not_found';
    }
    if (current.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.status !== 'draft') {
      return 'not_draft';
    }
    await this.db
      .deleteFrom('erp_invoices')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invoiceId)
      .execute();
    return true;
  }

  /**
   * Issues a draft: the trigger numbers it; the customer and issuer are
   * copied onto it. The caller checked the status and the lines.
   */
  async issue(
    invoiceId: string,
    expectedVersion: number,
    issue: {
      issuedBy: UserId | string;
      issueDate: string;
      dueDate: string;
      customerName: string;
      customerAddress: Address;
      contactName: string | null;
      contactEmail: string | null;
      issuer: IssuerSnapshot;
    },
  ): Promise<Invoice | InvoiceRefusal> {
    const row = await this.db
      .updateTable('erp_invoices')
      .set({
        status: 'issued',
        issued_by: toUserId(issue.issuedBy),
        issued_at: sql<Date>`now()`,
        issue_date: issue.issueDate,
        due_date: issue.dueDate,
        customer_name: issue.customerName,
        customer_address: sql`${JSON.stringify(issue.customerAddress)}::jsonb`,
        contact_name: issue.contactName,
        contact_email: issue.contactEmail,
        issuer: sql`${JSON.stringify(issue.issuer)}::jsonb`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invoiceId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? await this.#invoiceRefusal(invoiceId) : toInvoice(row);
  }

  /** Voids an issued invoice nothing was paid or credited against; it keeps its number. */
  async voidInvoice(
    invoiceId: string,
    expectedVersion: number,
    voidedBy: UserId | string,
    reason: string,
  ): Promise<Invoice | InvoiceRefusal | 'settled'> {
    try {
      const row = await this.db
        .updateTable('erp_invoices')
        .set({
          status: 'void',
          voided_by: toUserId(voidedBy),
          voided_at: sql<Date>`now()`,
          void_reason: reason.trim(),
          version: sql<number>`version + 1`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', invoiceId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? await this.#invoiceRefusal(invoiceId) : toInvoice(row);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'erp_invoices_void_settled') {
        return 'settled';
      }
      throw error;
    }
  }

  /**
   * How much of each sales order line is already on an invoice that is not
   * void, drafts included, leaving out `excludingInvoiceId`.
   */
  async invoicedOrderQuantities(
    salesOrderLineIds: readonly string[],
    excludingInvoiceId?: string,
  ): Promise<Map<string, string>> {
    if (salesOrderLineIds.length === 0) {
      return new Map();
    }
    const ids = [...new Set(salesOrderLineIds)];
    const { rows } = await sql<{ line_id: string; quantity: string }>`
      select l.sales_order_line_id as line_id, sum(l.quantity)::text as quantity
        from erp_invoice_lines l
        join erp_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
       where l.tenant_id = ${this.tenantId}
         and i.status <> 'void'
         and l.sales_order_line_id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
         ${excludingInvoiceId === undefined ? sql`` : sql`and i.id <> ${excludingInvoiceId}::uuid`}
       group by l.sales_order_line_id
    `.execute(this.db);
    return new Map(rows.map((row) => [row.line_id, trimDecimal(row.quantity)]));
  }

  /** The parts already on an invoice that is not void, leaving out `excludingInvoiceId`. */
  async invoicedMaterials(
    materialIds: readonly string[],
    excludingInvoiceId?: string,
  ): Promise<Set<string>> {
    if (materialIds.length === 0) {
      return new Set();
    }
    const ids = [...new Set(materialIds)];
    const { rows } = await sql<{ material_id: string }>`
      select distinct l.work_order_material_id as material_id
        from erp_invoice_lines l
        join erp_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
       where l.tenant_id = ${this.tenantId}
         and i.status <> 'void'
         and l.work_order_material_id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
         ${excludingInvoiceId === undefined ? sql`` : sql`and i.id <> ${excludingInvoiceId}::uuid`}
    `.execute(this.db);
    return new Set(rows.map((row) => row.material_id));
  }

  /** The invoices, not void, made from this job: a job is invoiced once. */
  async invoicesForWorkOrder(workOrderId: string): Promise<Invoice[]> {
    const rows = await this.db
      .selectFrom('erp_invoices')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('status', '<>', 'void')
      .orderBy('created_at')
      .execute();
    return rows.map(toInvoice);
  }

  /**
   * Holds the order or job an invoice bills until the transaction ends, so
   * two invoices drafted or issued at once from the same source take turns
   * and never bill the same thing twice.
   */
  async lockSource(kind: 'sales_order' | 'work_order', id: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${this.tenantId}:${kind}:${id}`}, 0))`.execute(
      this.db,
    );
  }

  // -------------------------------------------------------------------------
  // Credit notes
  // -------------------------------------------------------------------------

  async createCreditNote(
    invoiceId: string,
    reason: string,
    lines: readonly CreditNoteLineInput[],
    createdBy: UserId | string,
  ): Promise<CreditNote | 'invoice_not_open'> {
    try {
      const row = await this.db
        .insertInto('erp_credit_notes')
        .values({
          tenant_id: this.tenantId,
          invoice_id: invoiceId,
          reason: reason.trim(),
          created_by: toUserId(createdBy),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.#writeCreditNoteLines(row.id, lines);
      return toCreditNote(row);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'erp_credit_notes_invoice_not_open') {
        return 'invoice_not_open';
      }
      throw error;
    }
  }

  async findCreditNote(creditNoteId: string): Promise<CreditNote | undefined> {
    const row = await this.db
      .selectFrom('erp_credit_notes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', creditNoteId)
      .executeTakeFirst();
    return row === undefined ? undefined : toCreditNote(row);
  }

  async lockCreditNote(creditNoteId: string): Promise<CreditNote | undefined> {
    const row = await this.db
      .selectFrom('erp_credit_notes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', creditNoteId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toCreditNote(row);
  }

  async creditNotesForInvoice(invoiceId: string): Promise<CreditNote[]> {
    const rows = await this.db
      .selectFrom('erp_credit_notes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('invoice_id', '=', invoiceId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toCreditNote);
  }

  async listCreditNotes(
    query: {
      text?: string;
      statuses?: readonly CreditNoteStatus[];
      invoiceId?: string;
      after?: { createdAt: Date; id: string };
      limit?: number;
    } = {},
  ): Promise<{ items: CreditNote[]; next: { createdAt: Date; id: string } | undefined }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.db
      .selectFrom('erp_credit_notes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.text !== undefined && query.text.trim() !== '') {
      const reference = parseFinanceReference(query.text);
      select = select.where('reference', '=', reference ?? -1);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.invoiceId !== undefined) {
      select = select.where('invoice_id', '=', query.invoiceId);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(created_at, id) < (${query.after.createdAt}, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toCreditNote);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }

  async creditNoteLines(creditNoteId: string): Promise<CreditNoteLine[]> {
    const { rows } = await sql<CreditNoteLineRow>`
      select l.*, ${LINE_MATH}
        from erp_credit_note_lines l
       where l.tenant_id = ${this.tenantId} and l.credit_note_id = ${creditNoteId}
       order by l.position
    `.execute(this.db);
    return rows.map((row) => ({ ...toLine(row), invoiceLineId: row.invoice_line_id }));
  }

  async creditNoteTotals(creditNoteId: string): Promise<DocumentTotals> {
    return documentTotals(
      this.db,
      'erp_credit_note_lines',
      'credit_note_id',
      this.tenantId,
      creditNoteId,
    );
  }

  async updateCreditNoteDraft(
    creditNoteId: string,
    expectedVersion: number,
    input: { reason?: string },
    lines: readonly CreditNoteLineInput[] | undefined,
  ): Promise<CreditNote | InvoiceRefusal | 'not_draft'> {
    const current = await this.lockCreditNote(creditNoteId);
    if (current === undefined) {
      return 'not_found';
    }
    if (current.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.status !== 'draft') {
      return 'not_draft';
    }
    if (lines !== undefined) {
      await this.db
        .deleteFrom('erp_credit_note_lines')
        .where('tenant_id', '=', this.tenantId)
        .where('credit_note_id', '=', creditNoteId)
        .execute();
      await this.#writeCreditNoteLines(creditNoteId, lines);
    }
    const row = await this.db
      .updateTable('erp_credit_notes')
      .set({
        ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', creditNoteId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCreditNote(row);
  }

  async discardCreditNoteDraft(
    creditNoteId: string,
    expectedVersion: number,
  ): Promise<true | InvoiceRefusal | 'not_draft'> {
    const current = await this.lockCreditNote(creditNoteId);
    if (current === undefined) {
      return 'not_found';
    }
    if (current.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.status !== 'draft') {
      return 'not_draft';
    }
    await this.db
      .deleteFrom('erp_credit_notes')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', creditNoteId)
      .execute();
    return true;
  }

  /**
   * Issues a draft credit note: the trigger locks the invoice and refuses
   * more than it still owes; it numbers the note.
   */
  async issueCreditNote(
    creditNoteId: string,
    expectedVersion: number,
    issuedBy: UserId | string,
    issueDate: string,
  ): Promise<CreditNote | InvoiceRefusal | CreditNoteIssueRefusal> {
    try {
      const row = await this.db
        .updateTable('erp_credit_notes')
        .set({
          status: 'issued',
          issued_by: toUserId(issuedBy),
          issued_at: sql<Date>`now()`,
          issue_date: issueDate,
          version: sql<number>`version + 1`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', creditNoteId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        return (await this.findCreditNote(creditNoteId)) === undefined
          ? 'not_found'
          : 'version_conflict';
      }
      return toCreditNote(row);
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === 'erp_credit_notes_over_balance') {
        return 'over_balance';
      }
      if (constraint === 'erp_credit_notes_empty') {
        return 'empty';
      }
      if (constraint === 'erp_credit_notes_invoice_not_open') {
        return 'invoice_not_open';
      }
      throw error;
    }
  }

  async #invoiceRefusal(invoiceId: string): Promise<InvoiceRefusal> {
    return (await this.findInvoice(invoiceId)) === undefined ? 'not_found' : 'version_conflict';
  }

  async #writeInvoiceLines(invoiceId: string, lines: readonly InvoiceLineInput[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('erp_invoice_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: this.tenantId,
          invoice_id: invoiceId,
          position: index + 1,
          item_id: line.itemId ?? null,
          description: line.description.trim(),
          quantity: line.quantity,
          unit: line.unit ?? 'each',
          unit_price: line.unitPrice,
          discount_bp: line.discountBp ?? 0,
          tax_rate_bp: line.taxRateBp ?? 0,
          sales_order_line_id: line.salesOrderLineId ?? null,
          work_order_material_id: line.workOrderMaterialId ?? null,
        })),
      )
      .execute();
  }

  async #writeCreditNoteLines(
    creditNoteId: string,
    lines: readonly CreditNoteLineInput[],
  ): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('erp_credit_note_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: this.tenantId,
          credit_note_id: creditNoteId,
          position: index + 1,
          invoice_line_id: line.invoiceLineId ?? null,
          item_id: line.itemId ?? null,
          description: line.description.trim(),
          quantity: line.quantity,
          unit: line.unit ?? 'each',
          unit_price: line.unitPrice,
          discount_bp: line.discountBp ?? 0,
          tax_rate_bp: line.taxRateBp ?? 0,
        })),
      )
      .execute();
  }
}

export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = {
  legalName: null,
  address: null,
  taxReference: null,
  paymentInstructions: null,
  footer: null,
  defaultDueDays: 30,
  labourHourlyCost: null,
  labourHourlyRate: null,
  version: 0,
  updatedBy: null,
  updatedAt: null,
};

function toSettings(row: Selectable<ErpFinanceSettingsTable>): FinanceSettings {
  return {
    legalName: row.legal_name,
    address: row.address,
    taxReference: row.tax_reference,
    paymentInstructions: row.payment_instructions,
    footer: row.footer,
    defaultDueDays: row.default_due_days,
    labourHourlyCost: row.labour_hourly_cost === null ? null : trimDecimal(row.labour_hourly_cost),
    labourHourlyRate: row.labour_hourly_rate === null ? null : trimDecimal(row.labour_hourly_rate),
    version: row.version,
    updatedBy: row.updated_by === null ? null : toUserId(row.updated_by),
    updatedAt: row.updated_at,
  };
}

function toIssuer(value: Record<string, string | null> | null): IssuerSnapshot | null {
  if (value === null) {
    return null;
  }
  return {
    name: value.name ?? '',
    address: value.address ?? null,
    taxReference: value.taxReference ?? null,
    paymentInstructions: value.paymentInstructions ?? null,
    footer: value.footer ?? null,
  };
}

function toInvoice(row: Selectable<ErpInvoicesTable>): Invoice {
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    siteId: row.site_id,
    contactId: row.contact_id,
    salesOrderId: row.sales_order_id,
    workOrderId: row.work_order_id,
    status: row.status,
    currencyCode: row.currency_code,
    issueDate: toDayString(row.issue_date),
    dueDate: toDayString(row.due_date),
    notes: row.notes,
    internalNotes: row.internal_notes,
    customerName: row.customer_name,
    customerAddress: toAddress(row.customer_address),
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    issuer: toIssuer(row.issuer),
    issuedBy: row.issued_by === null ? null : toUserId(row.issued_by),
    issuedAt: row.issued_at,
    voidedBy: row.voided_by === null ? null : toUserId(row.voided_by),
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCreditNote(row: Selectable<ErpCreditNotesTable>): CreditNote {
  return {
    id: row.id,
    reference: row.reference,
    invoiceId: row.invoice_id,
    status: row.status,
    reason: row.reason,
    issueDate: toDayString(row.issue_date),
    issuedBy: row.issued_by === null ? null : toUserId(row.issued_by),
    issuedAt: row.issued_at,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
