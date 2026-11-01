import { type PaymentMethod, type UserId, parseFinanceReference, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  ErpPaymentAllocationsTable,
  ErpPaymentReceiptsTable,
  ErpPaymentReversalsTable,
} from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import { prefixQuery } from './customers.js';
import { blankToNull } from './sales-quotes.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Money a company received from its customers (CRM/ERP plan, phase B1;
 * ADR-0007).
 *
 * A receipt is recorded once and never changes (the runtime role may only
 * insert and read it). It is allocated to the same customer's issued
 * invoices; the database locks the receipt and the invoice while it decides
 * and refuses more than either has (`erp_payment_allocations_guard`). A
 * wrong allocation is removed, keeping who removed it and when; what is not
 * allocated stays on the customer's account.
 *
 * A receipt that should never have counted — a bounced cheque, the wrong
 * customer — is reversed (0064): a record of its own with a reason, which
 * removes the receipt's allocations and posts the opposite ledger entry. The
 * receipt stays, marked, and is never allocated again.
 */

export interface PaymentReceipt {
  id: string;
  reference: number;
  customerId: string;
  /** `YYYY-MM-DD`. */
  receivedOn: string;
  amount: string;
  currencyCode: string;
  method: PaymentMethod;
  paymentReference: string | null;
  notes: string | null;
  recordedBy: UserId;
  recordedAt: Date;
}

export interface PaymentReceiptInput {
  customerId: string;
  receivedOn: string;
  amount: string;
  currencyCode: string;
  method: PaymentMethod;
  paymentReference?: string | null;
  notes?: string | null;
}

export interface PaymentAllocation {
  id: string;
  receiptId: string;
  invoiceId: string;
  amount: string;
  allocatedBy: UserId;
  allocatedAt: Date;
  removedBy: UserId | null;
  removedAt: Date | null;
}

export interface ReceiptAmounts {
  amount: string;
  allocated: string;
  /** What is left on the customer's account from this receipt; nothing once reversed. */
  unallocated: string;
}

/** A receipt taken back (0064). */
export interface PaymentReversal {
  id: string;
  receiptId: string;
  reason: string;
  /** `YYYY-MM-DD`, the company's day; the ledger posts it on this day. */
  reversedOn: string;
  reversedBy: UserId;
  reversedAt: Date;
}

export type AllocationRefusal =
  'over_receipt' | 'over_invoice' | 'invoice_not_open' | 'mismatch' | 'receipt_reversed';

/** A customer's standing in one currency. */
export interface CustomerAccount {
  currencyCode: string;
  /** What issued invoices still owe. */
  owed: string;
  /** Received and not yet allocated to an invoice. */
  unallocated: string;
  /** `owed − unallocated`: what the customer owes once their credit is used. */
  net: string;
}

const ALLOCATION_REFUSALS: Record<string, AllocationRefusal> = {
  erp_payment_allocations_over_receipt: 'over_receipt',
  erp_payment_allocations_over_invoice: 'over_invoice',
  erp_payment_allocations_invoice_not_open: 'invoice_not_open',
  erp_payment_allocations_mismatch: 'mismatch',
  erp_payment_allocations_receipt_reversed: 'receipt_reversed',
};

export class FinancePaymentsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async recordReceipt(
    input: PaymentReceiptInput,
    recordedBy: UserId | string,
  ): Promise<PaymentReceipt> {
    const row = await this.db
      .insertInto('erp_payment_receipts')
      .values({
        tenant_id: this.tenantId,
        customer_id: input.customerId,
        received_on: input.receivedOn,
        amount: input.amount,
        currency_code: input.currencyCode,
        method: input.method,
        payment_reference: blankToNull(input.paymentReference),
        notes: blankToNull(input.notes),
        recorded_by: toUserId(recordedBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReceipt(row);
  }

  async findReceipt(receiptId: string): Promise<PaymentReceipt | undefined> {
    const row = await this.db
      .selectFrom('erp_payment_receipts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', receiptId)
      .executeTakeFirst();
    return row === undefined ? undefined : toReceipt(row);
  }

  async findReceipts(receiptIds: readonly string[]): Promise<PaymentReceipt[]> {
    if (receiptIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_payment_receipts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(receiptIds)])
      .execute();
    return rows.map(toReceipt);
  }

  /** Newest first. `unallocatedOnly` keeps receipts with money left on account. */
  async listReceipts(
    query: {
      text?: string;
      customerId?: string;
      unallocatedOnly?: boolean;
      after?: { recordedAt: Date; id: string };
      limit?: number;
    } = {},
  ): Promise<{ items: PaymentReceipt[]; next: { recordedAt: Date; id: string } | undefined }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.db
      .selectFrom('erp_payment_receipts')
      .selectAll('erp_payment_receipts')
      .where('erp_payment_receipts.tenant_id', '=', this.tenantId);
    if (query.text !== undefined && query.text.trim() !== '') {
      const reference = parseFinanceReference(query.text);
      if (reference !== undefined) {
        select = select.where('erp_payment_receipts.reference', '=', reference);
      } else {
        const words = prefixQuery(query.text);
        if (words !== undefined) {
          select = select.where((eb) =>
            eb.or([
              eb('erp_payment_receipts.payment_reference', 'ilike', `%${query.text!.trim()}%`),
              eb.exists(
                eb
                  .selectFrom('customers')
                  .select(sql`1`.as('one'))
                  .where('customers.tenant_id', '=', this.tenantId)
                  .whereRef('customers.id', '=', 'erp_payment_receipts.customer_id')
                  .where(sql<boolean>`customers.search @@ to_tsquery('simple', ${words})`),
              ),
            ]),
          );
        }
      }
    }
    if (query.customerId !== undefined) {
      select = select.where('erp_payment_receipts.customer_id', '=', query.customerId);
    }
    if (query.unallocatedOnly === true) {
      select = select.where(
        sql<boolean>`erp_payment_receipts.amount > coalesce((select sum(a.amount) from erp_payment_allocations a
          where a.tenant_id = erp_payment_receipts.tenant_id and a.receipt_id = erp_payment_receipts.id
            and a.removed_at is null), 0)
          and not exists (select 1 from erp_payment_reversals v
            where v.tenant_id = erp_payment_receipts.tenant_id and v.receipt_id = erp_payment_receipts.id)`,
      );
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(erp_payment_receipts.recorded_at, erp_payment_receipts.id) < (${query.after.recordedAt}, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy('erp_payment_receipts.recorded_at', 'desc')
      .orderBy('erp_payment_receipts.id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toReceipt);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { recordedAt: last.recordedAt, id: last.id }
          : undefined,
    };
  }

  async receiptAmounts(receiptIds: readonly string[]): Promise<Map<string, ReceiptAmounts>> {
    if (receiptIds.length === 0) {
      return new Map();
    }
    const ids = [...new Set(receiptIds)];
    const { rows } = await sql<{
      id: string;
      amount: string;
      allocated: string;
      reversed: boolean;
    }>`
      select r.id, r.amount::text as amount,
             coalesce((select sum(a.amount) from erp_payment_allocations a
                        where a.tenant_id = r.tenant_id and a.receipt_id = r.id and a.removed_at is null), 0)::text as allocated,
             exists (select 1 from erp_payment_reversals v
                      where v.tenant_id = r.tenant_id and v.receipt_id = r.id) as reversed
        from erp_payment_receipts r
       where r.tenant_id = ${this.tenantId}
         and r.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
    `.execute(this.db);
    return new Map(
      rows.map((row) => {
        const amount = trimDecimal(row.amount);
        const allocated = trimDecimal(row.allocated);
        // A reversed receipt has nothing left: the money went back.
        const unallocated = row.reversed ? '0' : subtract(amount, allocated);
        return [row.id, { amount, allocated, unallocated }];
      }),
    );
  }

  /** Puts part of a receipt against an invoice; the database refuses more than either has. */
  async allocate(
    receiptId: string,
    invoiceId: string,
    amount: string,
    allocatedBy: UserId | string,
  ): Promise<PaymentAllocation | AllocationRefusal> {
    try {
      const row = await this.db
        .insertInto('erp_payment_allocations')
        .values({
          tenant_id: this.tenantId,
          receipt_id: receiptId,
          invoice_id: invoiceId,
          amount,
          allocated_by: toUserId(allocatedBy),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAllocation(row);
    } catch (error) {
      const refusal = ALLOCATION_REFUSALS[(error as { constraint?: string }).constraint ?? ''];
      if (refusal !== undefined) {
        return refusal;
      }
      throw error;
    }
  }

  /**
   * Takes a receipt back (0064). The database removes its allocations and
   * queues the opposite ledger entry in the same statement; a receipt is
   * reversed once.
   */
  async reverseReceipt(
    receiptId: string,
    input: { reason: string; reversedOn: string },
    reversedBy: UserId | string,
  ): Promise<PaymentReversal | 'already_reversed'> {
    const row = await this.db
      .insertInto('erp_payment_reversals')
      .values({
        tenant_id: this.tenantId,
        receipt_id: receiptId,
        reason: input.reason.trim(),
        reversed_on: input.reversedOn,
        reversed_by: toUserId(reversedBy),
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'receipt_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'already_reversed' : toReversal(row);
  }

  /** The reversals of these receipts, by receipt. */
  async reversalsFor(receiptIds: readonly string[]): Promise<Map<string, PaymentReversal>> {
    if (receiptIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('erp_payment_reversals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('receipt_id', 'in', [...new Set(receiptIds)])
      .execute();
    return new Map(rows.map((row) => [row.receipt_id, toReversal(row)]));
  }

  async findAllocation(allocationId: string): Promise<PaymentAllocation | undefined> {
    const row = await this.db
      .selectFrom('erp_payment_allocations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', allocationId)
      .executeTakeFirst();
    return row === undefined ? undefined : toAllocation(row);
  }

  /** Takes an allocation back: the money returns to the customer's account; the record stays. */
  async removeAllocation(
    allocationId: string,
    removedBy: UserId | string,
  ): Promise<PaymentAllocation | 'not_found' | 'already_removed'> {
    const row = await this.db
      .updateTable('erp_payment_allocations')
      .set({ removed_by: toUserId(removedBy), removed_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', allocationId)
      .where('removed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return toAllocation(row);
    }
    return (await this.findAllocation(allocationId)) === undefined
      ? 'not_found'
      : 'already_removed';
  }

  async allocationsForReceipt(receiptId: string): Promise<PaymentAllocation[]> {
    const rows = await this.db
      .selectFrom('erp_payment_allocations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('receipt_id', '=', receiptId)
      .orderBy('allocated_at')
      .orderBy('id')
      .execute();
    return rows.map(toAllocation);
  }

  /** The payments allocated to an invoice and not removed. */
  async allocationsForInvoice(invoiceId: string): Promise<PaymentAllocation[]> {
    const rows = await this.db
      .selectFrom('erp_payment_allocations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('invoice_id', '=', invoiceId)
      .where('removed_at', 'is', null)
      .orderBy('allocated_at')
      .orderBy('id')
      .execute();
    return rows.map(toAllocation);
  }

  /** What a customer owes and has on account, per currency, summed in SQL. */
  async customerAccount(customerId: string): Promise<CustomerAccount[]> {
    const { rows } = await sql<{ currency_code: string; owed: string; unallocated: string }>`
      with owed as (
        select i.currency_code, sum(erp_invoice_balance(i.tenant_id, i.id)) as owed
          from erp_invoices i
         where i.tenant_id = ${this.tenantId} and i.customer_id = ${customerId}::uuid and i.status = 'issued'
         group by i.currency_code
      ), credit as (
        select r.currency_code,
               sum(r.amount - coalesce((select sum(a.amount) from erp_payment_allocations a
                                         where a.tenant_id = r.tenant_id and a.receipt_id = r.id
                                           and a.removed_at is null), 0)) as unallocated
          from erp_payment_receipts r
         where r.tenant_id = ${this.tenantId} and r.customer_id = ${customerId}::uuid
           and not exists (select 1 from erp_payment_reversals v
                            where v.tenant_id = r.tenant_id and v.receipt_id = r.id)
         group by r.currency_code
      )
      select coalesce(o.currency_code, c.currency_code) as currency_code,
             coalesce(o.owed, 0)::text as owed,
             coalesce(c.unallocated, 0)::text as unallocated
        from owed o full outer join credit c on c.currency_code = o.currency_code
       order by 1
    `.execute(this.db);
    return rows
      .map((row) => {
        const owed = trimDecimal(row.owed);
        const unallocated = trimDecimal(row.unallocated);
        return {
          currencyCode: row.currency_code,
          owed,
          unallocated,
          net: subtract(owed, unallocated),
        };
      })
      .filter((row) => row.owed !== '0' || row.unallocated !== '0');
  }
}

/** `a − b` for decimal strings of up to four places, exactly. */
function subtract(a: string, b: string): string {
  const scale = (text: string) => {
    const negative = text.startsWith('-');
    const [whole = '0', fraction = ''] = text.replace(/^-/u, '').split('.');
    const value = BigInt(whole + fraction.padEnd(4, '0').slice(0, 4));
    return negative ? -value : value;
  };
  const difference = scale(a) - scale(b);
  const digits = (difference < 0n ? -difference : difference).toString().padStart(5, '0');
  const text = `${digits.slice(0, -4)}.${digits.slice(-4)}`.replace(/\.?0+$/u, '');
  return difference < 0n ? `-${text}` : text === '' ? '0' : text;
}

function toReceipt(row: Selectable<ErpPaymentReceiptsTable>): PaymentReceipt {
  return {
    id: row.id,
    reference: row.reference ?? 0,
    customerId: row.customer_id,
    receivedOn: toDayString(row.received_on)!,
    amount: trimDecimal(row.amount),
    currencyCode: row.currency_code,
    method: row.method,
    paymentReference: row.payment_reference,
    notes: row.notes,
    recordedBy: toUserId(row.recorded_by),
    recordedAt: row.recorded_at,
  };
}

function toReversal(row: Selectable<ErpPaymentReversalsTable>): PaymentReversal {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    reason: row.reason,
    reversedOn: toDayString(row.reversed_on)!,
    reversedBy: toUserId(row.reversed_by),
    reversedAt: row.reversed_at,
  };
}

function toAllocation(row: Selectable<ErpPaymentAllocationsTable>): PaymentAllocation {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    invoiceId: row.invoice_id,
    amount: trimDecimal(row.amount),
    allocatedBy: toUserId(row.allocated_by),
    allocatedAt: row.allocated_at,
    removedBy: row.removed_by === null ? null : toUserId(row.removed_by),
    removedAt: row.removed_at,
  };
}
