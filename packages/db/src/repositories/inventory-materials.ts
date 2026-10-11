import { type MaterialStatus, type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpWorkOrderMaterialsTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Parts used on jobs (CRM/ERP plan, phase E2; ADR-0005).
 *
 * A row is the record of a use; the stock it took is a `consumption` movement
 * in the ledger, posted by the caller under the balance's lock. A use the
 * location could not cover is kept as a `conflict` — what was asked for and
 * what was there — until somebody resolves it. Costs are the item's average at
 * the moment of posting, `numeric(20,4)`, summed in SQL.
 */

export interface Material {
  id: string;
  workOrderId: string;
  itemId: string;
  locationId: string | null;
  quantity: string;
  returnedQuantity: string;
  unitCost: string | null;
  status: MaterialStatus;
  availableQuantity: string | null;
  clientActionId: string | null;
  note: string | null;
  recordedBy: UserId;
  recordedAt: Date;
  occurredAt: Date;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
  version: number;
}

export interface MaterialInput {
  workOrderId: string;
  itemId: string;
  locationId: string | null;
  quantity: string;
  unitCost: string | null;
  status: MaterialStatus;
  availableQuantity?: string | null;
  clientActionId?: string | null;
  note?: string | null;
  recordedBy: UserId | string;
  occurredAt?: Date;
}

export interface MaterialPatch {
  status?: MaterialStatus;
  quantity?: string;
  locationId?: string | null;
  unitCost?: string | null;
  availableQuantity?: string | null;
  note?: string | null;
  cancelledBy?: UserId | string | null;
}

export class InventoryMaterialsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(input: MaterialInput): Promise<Material> {
    const row = await this.db
      .insertInto('erp_work_order_materials')
      .values({
        tenant_id: this.tenantId,
        work_order_id: input.workOrderId,
        item_id: input.itemId,
        location_id: input.locationId,
        quantity: input.quantity,
        unit_cost: input.unitCost,
        status: input.status,
        available_quantity: input.availableQuantity ?? null,
        client_action_id: input.clientActionId ?? null,
        note: blankToNull(input.note),
        recorded_by: toUserId(input.recordedBy),
        ...(input.occurredAt === undefined ? {} : { occurred_at: input.occurredAt }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMaterial(row);
  }

  async find(materialId: string): Promise<Material | undefined> {
    const row = await this.db
      .selectFrom('erp_work_order_materials')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', materialId)
      .executeTakeFirst();
    return row === undefined ? undefined : toMaterial(row);
  }

  /** Locks the row for the rest of the transaction: resolving a conflict happens once. */
  async lock(materialId: string): Promise<Material | undefined> {
    const row = await this.db
      .selectFrom('erp_work_order_materials')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', materialId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toMaterial(row);
  }

  /** The use a phone recorded under this action id, if it has arrived before. */
  async findByClientActionId(clientActionId: string): Promise<Material | undefined> {
    const row = await this.db
      .selectFrom('erp_work_order_materials')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('client_action_id', '=', clientActionId)
      .executeTakeFirst();
    return row === undefined ? undefined : toMaterial(row);
  }

  async listForJob(workOrderId: string): Promise<Material[]> {
    const rows = await this.db
      .selectFrom('erp_work_order_materials')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .orderBy('recorded_at')
      .orderBy('id')
      .execute();
    return rows.map(toMaterial);
  }

  /** Uses waiting for somebody to decide, newest first. */
  async listConflicts(limit = 50): Promise<Material[]> {
    const rows = await this.db
      .selectFrom('erp_work_order_materials')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'conflict')
      .orderBy('recorded_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();
    return rows.map(toMaterial);
  }

  async update(materialId: string, patch: MaterialPatch): Promise<Material> {
    const row = await this.db
      .updateTable('erp_work_order_materials')
      .set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.quantity === undefined ? {} : { quantity: patch.quantity }),
        ...(patch.locationId === undefined ? {} : { location_id: patch.locationId }),
        ...(patch.unitCost === undefined ? {} : { unit_cost: patch.unitCost }),
        ...(patch.availableQuantity === undefined
          ? {}
          : { available_quantity: patch.availableQuantity }),
        ...(patch.note === undefined ? {} : { note: blankToNull(patch.note) }),
        ...(patch.cancelledBy === undefined
          ? {}
          : patch.cancelledBy === null
            ? { cancelled_by: null, cancelled_at: null }
            : { cancelled_by: toUserId(patch.cancelledBy), cancelled_at: sql<Date>`now()` }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', materialId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMaterial(row);
  }

  /** Records a return of part of what was used; the check constraint refuses more than was used. */
  async addReturned(materialId: string, quantity: string): Promise<Material> {
    const row = await this.db
      .updateTable('erp_work_order_materials')
      .set({
        returned_quantity: sql<string>`returned_quantity + ${quantity}::numeric`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', materialId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMaterial(row);
  }

  /** What the posted parts on a job cost, net of returns, as a decimal string. */
  async costForJob(workOrderId: string): Promise<string> {
    const row = await this.db
      .selectFrom('erp_work_order_materials')
      .select(
        sql<string>`coalesce(sum((quantity - returned_quantity) * coalesce(unit_cost, 0)), 0)::text`.as(
          'total',
        ),
      )
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('status', '=', 'posted')
      .executeTakeFirstOrThrow();
    return trimDecimal(row.total);
  }
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toMaterial(row: Selectable<ErpWorkOrderMaterialsTable>): Material {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    itemId: row.item_id,
    locationId: row.location_id,
    quantity: trimDecimal(row.quantity),
    returnedQuantity: trimDecimal(row.returned_quantity),
    unitCost: row.unit_cost === null ? null : trimDecimal(row.unit_cost),
    status: row.status,
    availableQuantity: row.available_quantity === null ? null : trimDecimal(row.available_quantity),
    clientActionId: row.client_action_id,
    note: row.note,
    recordedBy: toUserId(row.recorded_by),
    recordedAt: row.recorded_at,
    occurredAt: row.occurred_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    version: row.version,
  };
}
