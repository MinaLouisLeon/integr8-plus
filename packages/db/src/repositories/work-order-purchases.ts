import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpWorkOrderPurchasesTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Parts an engineer bought from a merchant for a job (eighth round;
 * ADR-0012): on the job, with the price paid and a receipt photo, and in the
 * job's cost; never in stock. Recorded from the phone offline, under the id
 * the phone chose, so a resend lands once. Paying the engineer back stays an
 * expense claim.
 */

export interface WorkOrderPurchase {
  id: string;
  workOrderId: string;
  itemId: string | null;
  description: string;
  merchant: string | null;
  quantity: string;
  /** Paid for one, in the company currency. */
  unitPrice: string;
  note: string | null;
  recordedBy: UserId;
  occurredAt: Date;
  recordedAt: Date;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
}

export interface WorkOrderPurchaseInput {
  id: string;
  workOrderId: string;
  itemId: string | null;
  description: string;
  merchant: string | null;
  quantity: string;
  unitPrice: string;
  note: string | null;
  occurredAt?: Date | undefined;
}

export class WorkOrderPurchasesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(
    input: WorkOrderPurchaseInput,
    recordedBy: UserId | string,
  ): Promise<WorkOrderPurchase> {
    const row = await this.db
      .insertInto('erp_work_order_purchases')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        work_order_id: input.workOrderId,
        item_id: input.itemId,
        description: input.description.trim(),
        merchant: input.merchant,
        quantity: input.quantity,
        unit_price: input.unitPrice,
        note: input.note,
        recorded_by: toUserId(recordedBy),
        ...(input.occurredAt === undefined ? {} : { occurred_at: input.occurredAt }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPurchase(row);
  }

  async find(purchaseId: string): Promise<WorkOrderPurchase | undefined> {
    const row = await this.db
      .selectFrom('erp_work_order_purchases')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', purchaseId)
      .executeTakeFirst();
    return row === undefined ? undefined : toPurchase(row);
  }

  /** A job's purchases, cancelled ones included, oldest first. */
  async forJob(workOrderId: string): Promise<WorkOrderPurchase[]> {
    return (
      await this.db
        .selectFrom('erp_work_order_purchases')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('work_order_id', '=', workOrderId)
        .orderBy('occurred_at')
        .orderBy('id')
        .execute()
    ).map(toPurchase);
  }

  /** What a job's purchases cost, cancelled ones left out. */
  async totalForJob(workOrderId: string): Promise<string> {
    const { rows } = await sql<{ total: string }>`
      select coalesce(sum(round(quantity * unit_price, 4)), 0)::text as total
        from erp_work_order_purchases
       where tenant_id = ${this.tenantId} and work_order_id = ${workOrderId}::uuid
         and cancelled_at is null
    `.execute(this.db);
    return trimDecimal(rows[0]!.total);
  }

  async cancel(purchaseId: string, by: UserId | string): Promise<WorkOrderPurchase | undefined> {
    const row = await this.db
      .updateTable('erp_work_order_purchases')
      .set({ cancelled_by: toUserId(by), cancelled_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', purchaseId)
      .where('cancelled_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toPurchase(row);
  }
}

function toPurchase(row: Selectable<ErpWorkOrderPurchasesTable>): WorkOrderPurchase {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    itemId: row.item_id,
    description: row.description,
    merchant: row.merchant,
    quantity: trimDecimal(row.quantity),
    unitPrice: trimDecimal(row.unit_price),
    note: row.note,
    recordedBy: toUserId(row.recorded_by),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
  };
}
