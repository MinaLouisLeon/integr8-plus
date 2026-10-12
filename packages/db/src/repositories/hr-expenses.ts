import {
  type ExpenseClaimStatus,
  type ExpensePaidVia,
  type ExpenseSettlement,
  toUserId,
  type UserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { HrExpenseCategoriesTable, HrExpenseClaimsTable } from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Staff expense claims and their categories (0037; ADR-0010). A claim never
 * changes once submitted and is never deleted; its status moves forward only,
 * which the database's guard enforces. Callers check each move first, so a
 * refusal can be said in words.
 */

export interface ExpenseCategory {
  id: string;
  name: string;
  accountId: string | null;
  archivedAt: Date | null;
  version: number;
}

export interface ExpenseClaim {
  id: string;
  reference: number;
  claimantId: UserId;
  categoryId: string;
  workOrderId: string | null;
  /** `YYYY-MM-DD`. */
  spentOn: string;
  amount: string;
  currency: string;
  description: string;
  status: ExpenseClaimStatus;
  clientActionId: string | null;
  submittedAt: Date;
  decidedBy: UserId | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  settleVia: ExpenseSettlement | null;
  paidVia: ExpensePaidVia | null;
  paidBy: UserId | null;
  paidAt: Date | null;
  paymentReference: string | null;
  version: number;
}

export interface ExpenseClaimInput {
  claimantId: UserId | string;
  categoryId: string;
  workOrderId?: string | null;
  spentOn: string;
  amount: string;
  currency: string;
  description: string;
  clientActionId?: string | null;
}

export interface ExpenseClaimQuery {
  claimantId?: string | undefined;
  statuses?: readonly ExpenseClaimStatus[] | undefined;
  reference?: number | undefined;
  before?: { at: string; id: string } | undefined;
  limit: number;
}

function toCategory(row: Selectable<HrExpenseCategoriesTable>): ExpenseCategory {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    archivedAt: row.archived_at,
    version: row.version,
  };
}

function toClaim(row: Selectable<HrExpenseClaimsTable>): ExpenseClaim {
  return {
    id: row.id,
    reference: row.reference,
    claimantId: toUserId(row.claimant_id),
    categoryId: row.category_id,
    workOrderId: row.work_order_id,
    spentOn: toDayString(row.spent_on) ?? '',
    amount: trimDecimal(row.amount),
    currency: row.currency,
    description: row.description,
    status: row.status,
    clientActionId: row.client_action_id,
    submittedAt: row.submitted_at,
    decidedBy: row.decided_by === null ? null : toUserId(row.decided_by),
    decidedAt: row.decided_at,
    rejectReason: row.reject_reason,
    settleVia: row.settle_via,
    paidVia: row.paid_via,
    paidBy: row.paid_by === null ? null : toUserId(row.paid_by),
    paidAt: row.paid_at,
    paymentReference: row.payment_reference,
    version: row.version,
  };
}

export class HrExpensesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  async categories(options: { includeArchived?: boolean } = {}): Promise<ExpenseCategory[]> {
    let select = this.db
      .selectFrom('hr_expense_categories')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (options.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    return (await select.orderBy(sql`lower(name)`).execute()).map(toCategory);
  }

  async category(id: string): Promise<ExpenseCategory | undefined> {
    const row = await this.db
      .selectFrom('hr_expense_categories')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toCategory(row);
  }

  async #nameTaken(name: string, exceptId?: string): Promise<boolean> {
    let select = this.db
      .selectFrom('hr_expense_categories')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('archived_at', 'is', null)
      .where(sql<boolean>`lower(name) = lower(${name})`);
    if (exceptId !== undefined) {
      select = select.where('id', '<>', exceptId);
    }
    return (await select.executeTakeFirst()) !== undefined;
  }

  async createCategory(
    input: { name: string; accountId: string | null },
    by: UserId | string,
  ): Promise<ExpenseCategory | 'name_taken'> {
    if (await this.#nameTaken(input.name)) {
      return 'name_taken';
    }
    const row = await this.db
      .insertInto('hr_expense_categories')
      .values({
        tenant_id: this.tenantId,
        name: input.name,
        account_id: input.accountId,
        created_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCategory(row);
  }

  async updateCategory(
    id: string,
    expectedVersion: number,
    changes: { name?: string; accountId?: string | null; archived?: boolean },
  ): Promise<ExpenseCategory | 'name_taken' | 'version_conflict'> {
    if (changes.name !== undefined && (await this.#nameTaken(changes.name, id))) {
      return 'name_taken';
    }
    const row = await this.db
      .updateTable('hr_expense_categories')
      .set({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.accountId === undefined ? {} : { account_id: changes.accountId }),
        ...(changes.archived === undefined
          ? {}
          : { archived_at: changes.archived ? sql<Date>`now()` : null }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toCategory(row);
  }

  // -------------------------------------------------------------------------
  // Claims
  // -------------------------------------------------------------------------

  async find(id: string): Promise<ExpenseClaim | undefined> {
    const row = await this.db
      .selectFrom('hr_expense_claims')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toClaim(row);
  }

  async findMany(ids: readonly string[]): Promise<ExpenseClaim[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('hr_expense_claims')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(ids)])
      .execute();
    return rows.map(toClaim);
  }

  async lock(id: string): Promise<ExpenseClaim | undefined> {
    const row = await this.db
      .selectFrom('hr_expense_claims')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toClaim(row);
  }

  /** The claim a phone submitted under this id. */
  async findByClientAction(clientActionId: string): Promise<ExpenseClaim | undefined> {
    const row = await this.db
      .selectFrom('hr_expense_claims')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('client_action_id', '=', clientActionId)
      .executeTakeFirst();
    return row === undefined ? undefined : toClaim(row);
  }

  /** Submits a claim; a phone's resent claim returns the first, unchanged. */
  async submit(input: ExpenseClaimInput): Promise<{ claim: ExpenseClaim; created: boolean }> {
    if (input.clientActionId !== undefined && input.clientActionId !== null) {
      const existing = await this.db
        .selectFrom('hr_expense_claims')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('client_action_id', '=', input.clientActionId)
        .executeTakeFirst();
      if (existing !== undefined) {
        return { claim: toClaim(existing), created: false };
      }
    }
    const row = await this.db
      .insertInto('hr_expense_claims')
      .values({
        tenant_id: this.tenantId,
        claimant_id: toUserId(input.claimantId),
        category_id: input.categoryId,
        work_order_id: input.workOrderId ?? null,
        spent_on: input.spentOn,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        client_action_id: input.clientActionId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { claim: toClaim(row), created: true };
  }

  /** Newest first. */
  async list(query: ExpenseClaimQuery): Promise<{
    items: ExpenseClaim[];
    next?: { at: string; id: string };
  }> {
    let select = this.db
      .selectFrom('hr_expense_claims')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.claimantId !== undefined) {
      select = select.where('claimant_id', '=', toUserId(query.claimantId));
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.reference !== undefined) {
      select = select.where('reference', '=', query.reference);
    }
    if (query.before !== undefined) {
      const { at, id } = query.before;
      select = select.where(sql<boolean>`(submitted_at, id) < (${at}::timestamptz, ${id}::uuid)`);
    }
    const rows = await select
      .orderBy('submitted_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const items = rows.slice(0, query.limit).map(toClaim);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { at: last.submittedAt.toISOString(), id: last.id } }
        : {}),
    };
  }

  async #move(
    id: string,
    expectedVersion: number,
    set: Partial<Record<keyof HrExpenseClaimsTable, unknown>>,
  ): Promise<ExpenseClaim | undefined> {
    const row = await this.db
      .updateTable('hr_expense_claims')
      .set({ ...(set as Record<string, never>), version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toClaim(row);
  }

  withdraw(id: string, expectedVersion: number): Promise<ExpenseClaim | undefined> {
    return this.#move(id, expectedVersion, { status: 'withdrawn' });
  }

  approve(
    id: string,
    expectedVersion: number,
    by: UserId | string,
    settleVia: ExpenseSettlement,
  ): Promise<ExpenseClaim | undefined> {
    return this.#move(id, expectedVersion, {
      status: 'approved',
      decided_by: toUserId(by),
      decided_at: sql<Date>`now()`,
      settle_via: settleVia,
    });
  }

  reject(
    id: string,
    expectedVersion: number,
    by: UserId | string,
    reason: string,
  ): Promise<ExpenseClaim | undefined> {
    return this.#move(id, expectedVersion, {
      status: 'rejected',
      decided_by: toUserId(by),
      decided_at: sql<Date>`now()`,
      reject_reason: reason,
    });
  }

  /** Paid back directly, by cash or bank transfer. */
  pay(
    id: string,
    expectedVersion: number,
    by: UserId | string,
    via: 'cash' | 'bank_transfer',
    reference: string | null,
  ): Promise<ExpenseClaim | undefined> {
    return this.#move(id, expectedVersion, {
      status: 'paid',
      paid_via: via,
      paid_by: toUserId(by),
      paid_at: sql<Date>`now()`,
      payment_reference: reference,
    });
  }

  /** Approved claims waiting for the next pay run, by claimant. */
  async awaitingPayroll(claimantIds?: readonly string[]): Promise<ExpenseClaim[]> {
    let select = this.db
      .selectFrom('hr_expense_claims')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'approved')
      .where('settle_via', '=', 'payroll');
    if (claimantIds !== undefined) {
      if (claimantIds.length === 0) {
        return [];
      }
      select = select.where(
        'claimant_id',
        'in',
        claimantIds.map((id) => toUserId(id)),
      );
    }
    return (await select.orderBy('submitted_at').execute()).map(toClaim);
  }

  /** How many claims wait for a decision, for a badge. */
  async waitingCount(): Promise<number> {
    const row = await this.db
      .selectFrom('hr_expense_claims')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'submitted')
      .executeTakeFirst();
    return row?.n ?? 0;
  }
}
