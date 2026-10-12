import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpVanRequestsTable, VanRequestStatus } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Keeping places stocked (eighth round; ADR-0012): what a location needs to
 * get back to its reorder levels, and engineers' requests to refill their
 * vans, which a store person picks from a warehouse. Moving the stock is the
 * stock ledger's; this keeps the requests.
 */

export interface ReorderNeed {
  itemId: string;
  minimum: string;
  onHand: string;
  /** Ordered for this location and not yet received, on open orders. */
  onOrder: string;
  /** What brings it back to its level: minimum less on hand and on order. */
  short: string;
  preferredSupplierId: string | null;
}

export interface VanRequest {
  id: string;
  vanLocationId: string;
  status: VanRequestStatus;
  notes: string | null;
  requestedBy: UserId;
  fromLocationId: string | null;
  pickedBy: UserId | null;
  pickedAt: Date | null;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VanRequestLine {
  itemId: string;
  quantityRequested: string;
  /** What was sent, once picked. */
  quantityPicked: string | null;
}

export type VanRequestRefusal = 'not_found' | 'version_conflict' | 'not_open';

export class InventoryReplenishmentRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /**
   * Items below their reorder level at a location, counting what is already
   * on order for it: drafts, approved and partly received purchase orders
   * delivering there. Archived items and services are left out.
   */
  async reorderNeeds(locationId: string): Promise<ReorderNeed[]> {
    const { rows } = await sql<{
      item_id: string;
      minimum: string;
      on_hand: string;
      on_order: string;
      short: string;
      preferred_supplier_id: string | null;
    }>`
      with levels as (
        select r.item_id, r.minimum, coalesce(b.on_hand, 0) as on_hand,
               coalesce((
                 select sum(l.quantity_ordered - l.quantity_received)
                   from erp_purchase_order_lines l
                   join erp_purchase_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
                  where l.tenant_id = r.tenant_id and l.item_id = r.item_id
                    and o.delivery_location_id = r.location_id
                    and o.status in ('draft', 'approved', 'partially_received')), 0) as on_order,
               i.preferred_supplier_id, i.name
          from erp_reorder_levels r
          join erp_items i on i.tenant_id = r.tenant_id and i.id = r.item_id
          left join erp_stock_balances b
            on b.tenant_id = r.tenant_id and b.item_id = r.item_id and b.location_id = r.location_id
         where r.tenant_id = ${this.tenantId} and r.location_id = ${locationId}::uuid
           and i.archived_at is null and i.kind = 'stock_item'
      )
      select item_id, minimum::text, on_hand::text, on_order::text,
             (minimum - on_hand - on_order)::text as short, preferred_supplier_id
        from levels
       where on_hand + on_order < minimum
       order by lower(name), item_id
    `.execute(this.db);
    return rows.map((row) => ({
      itemId: row.item_id,
      minimum: trimDecimal(row.minimum),
      onHand: trimDecimal(row.on_hand),
      onOrder: trimDecimal(row.on_order),
      short: trimDecimal(row.short),
      preferredSupplierId: row.preferred_supplier_id,
    }));
  }

  // -------------------------------------------------------------------------
  // Van requests
  // -------------------------------------------------------------------------

  async createRequest(
    input: {
      vanLocationId: string;
      notes: string | null;
      lines: readonly { itemId: string; quantity: string }[];
    },
    requestedBy: UserId | string,
  ): Promise<VanRequest> {
    const row = await this.db
      .insertInto('erp_van_requests')
      .values({
        tenant_id: this.tenantId,
        van_location_id: input.vanLocationId,
        notes: input.notes,
        requested_by: toUserId(requestedBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.db
      .insertInto('erp_van_request_lines')
      .values(
        input.lines.map((line) => ({
          tenant_id: this.tenantId,
          request_id: row.id,
          item_id: line.itemId,
          quantity_requested: line.quantity,
        })),
      )
      .execute();
    return toRequest(row);
  }

  async findRequest(
    requestId: string,
    options: { lock?: boolean } = {},
  ): Promise<VanRequest | undefined> {
    let select = this.db
      .selectFrom('erp_van_requests')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', requestId);
    if (options.lock === true) {
      select = select.forUpdate();
    }
    const row = await select.executeTakeFirst();
    return row === undefined ? undefined : toRequest(row);
  }

  async requestLines(requestIds: readonly string[]): Promise<Map<string, VanRequestLine[]>> {
    const lines = new Map<string, VanRequestLine[]>();
    if (requestIds.length === 0) {
      return lines;
    }
    const rows = await this.db
      .selectFrom('erp_van_request_lines as l')
      .innerJoin('erp_items as i', (join) =>
        join.onRef('i.tenant_id', '=', 'l.tenant_id').onRef('i.id', '=', 'l.item_id'),
      )
      .select(['l.request_id', 'l.item_id', 'l.quantity_requested', 'l.quantity_picked'])
      .where('l.tenant_id', '=', this.tenantId)
      .where('l.request_id', 'in', [...new Set(requestIds)])
      .orderBy(sql`lower(i.name)`)
      .execute();
    for (const row of rows) {
      const list = lines.get(row.request_id) ?? [];
      list.push({
        itemId: row.item_id,
        quantityRequested: trimDecimal(row.quantity_requested),
        quantityPicked: row.quantity_picked === null ? null : trimDecimal(row.quantity_picked),
      });
      lines.set(row.request_id, list);
    }
    return lines;
  }

  /** Open ones oldest first (the store's queue), then the rest newest first. */
  async listRequests(
    query: { statuses?: readonly VanRequestStatus[]; vanLocationId?: string; limit?: number } = {},
  ): Promise<VanRequest[]> {
    let select = this.db
      .selectFrom('erp_van_requests')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.vanLocationId !== undefined) {
      select = select.where('van_location_id', '=', query.vanLocationId);
    }
    return (
      await select
        .orderBy(sql`case when status = 'open' then 0 else 1 end`)
        .orderBy(sql`case when status = 'open' then created_at end`, 'asc')
        .orderBy('created_at', 'desc')
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
        .execute()
    ).map(toRequest);
  }

  /** Marks an open request picked from a location, with what was sent of each line. */
  async markPicked(
    requestId: string,
    expectedVersion: number,
    input: { fromLocationId: string; picked: ReadonlyMap<string, string> },
    pickedBy: UserId | string,
  ): Promise<VanRequest | VanRequestRefusal> {
    const row = await this.db
      .updateTable('erp_van_requests')
      .set({
        status: 'picked',
        from_location_id: input.fromLocationId,
        picked_by: toUserId(pickedBy),
        picked_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', requestId)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'open')
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      return this.#refusal(requestId, expectedVersion);
    }
    for (const [itemId, quantity] of input.picked) {
      await this.db
        .updateTable('erp_van_request_lines')
        .set({ quantity_picked: quantity })
        .where('tenant_id', '=', this.tenantId)
        .where('request_id', '=', requestId)
        .where('item_id', '=', itemId)
        .execute();
    }
    return toRequest(row);
  }

  async cancel(
    requestId: string,
    expectedVersion: number,
    cancelledBy: UserId | string,
  ): Promise<VanRequest | VanRequestRefusal> {
    const row = await this.db
      .updateTable('erp_van_requests')
      .set({
        status: 'cancelled',
        cancelled_by: toUserId(cancelledBy),
        cancelled_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', requestId)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'open')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? this.#refusal(requestId, expectedVersion) : toRequest(row);
  }

  async #refusal(requestId: string, expectedVersion: number): Promise<VanRequestRefusal> {
    const current = await this.findRequest(requestId);
    if (current === undefined) {
      return 'not_found';
    }
    return current.version !== expectedVersion ? 'version_conflict' : 'not_open';
  }
}

function toRequest(row: Selectable<ErpVanRequestsTable>): VanRequest {
  return {
    id: row.id,
    vanLocationId: row.van_location_id,
    status: row.status,
    notes: row.notes,
    requestedBy: toUserId(row.requested_by),
    fromLocationId: row.from_location_id,
    pickedBy: row.picked_by === null ? null : toUserId(row.picked_by),
    pickedAt: row.picked_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
