import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpSalesDeliveriesTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Goods handed over on a sales order (eighth round; ADR-0012): some or all of
 * its lines, from one location, never more than ordered. The stock leaves
 * through the ledger, with the delivery's id as the posting; this keeps the
 * delivery note and moves the order's lines on.
 */

export interface SalesDelivery {
  id: string;
  reference: number;
  orderId: string;
  locationId: string;
  notes: string | null;
  deliveredBy: UserId;
  deliveredAt: Date;
}

export interface SalesDeliveryLine {
  id: string;
  deliveryId: string;
  orderLineId: string;
  quantity: string;
  unitCost: string | null;
}

export class SalesDeliveriesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(
    input: {
      orderId: string;
      locationId: string;
      notes: string | null;
      lines: readonly { orderLineId: string; quantity: string; unitCost: string | null }[];
    },
    deliveredBy: UserId | string,
  ): Promise<{ delivery: SalesDelivery; lines: SalesDeliveryLine[] }> {
    const row = await this.db
      .insertInto('erp_sales_deliveries')
      .values({
        tenant_id: this.tenantId,
        order_id: input.orderId,
        location_id: input.locationId,
        notes: input.notes,
        delivered_by: toUserId(deliveredBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const lines = await this.db
      .insertInto('erp_sales_delivery_lines')
      .values(
        input.lines.map((line) => ({
          tenant_id: this.tenantId,
          delivery_id: row.id,
          order_line_id: line.orderLineId,
          quantity: line.quantity,
          unit_cost: line.unitCost,
        })),
      )
      .returningAll()
      .execute();
    return { delivery: toDelivery(row), lines: lines.map(toLine) };
  }

  /**
   * Counts a delivered quantity against an order line: fulfilled goes up and
   * the reservation comes down — by the quantity when it was delivered from
   * where it was reserved, and never above what is left to deliver.
   */
  async fulfilLine(orderLineId: string, quantity: string, fromLocationId: string): Promise<void> {
    await sql`
      update erp_sales_order_lines l
         set quantity_fulfilled = l.quantity_fulfilled + ${quantity}::numeric,
             quantity_reserved = greatest(0, least(
               case when l.reserve_location_id = ${fromLocationId}::uuid
                    then l.quantity_reserved - ${quantity}::numeric
                    else l.quantity_reserved end,
               l.quantity - l.quantity_fulfilled - ${quantity}::numeric))
       where l.tenant_id = ${this.tenantId} and l.id = ${orderLineId}::uuid
    `.execute(this.db);
  }

  async find(deliveryId: string): Promise<SalesDelivery | undefined> {
    const row = await this.db
      .selectFrom('erp_sales_deliveries')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', deliveryId)
      .executeTakeFirst();
    return row === undefined ? undefined : toDelivery(row);
  }

  /** An order's deliveries, oldest first. */
  async forOrder(orderId: string): Promise<SalesDelivery[]> {
    return (
      await this.db
        .selectFrom('erp_sales_deliveries')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('order_id', '=', orderId)
        .orderBy('delivered_at')
        .orderBy('reference')
        .execute()
    ).map(toDelivery);
  }

  async lines(deliveryIds: readonly string[]): Promise<SalesDeliveryLine[]> {
    if (deliveryIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_sales_delivery_lines')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('delivery_id', 'in', [...new Set(deliveryIds)])
        .execute()
    ).map(toLine);
  }
}

function toDelivery(row: Selectable<ErpSalesDeliveriesTable>): SalesDelivery {
  return {
    id: row.id,
    reference: row.reference,
    orderId: row.order_id,
    locationId: row.location_id,
    notes: row.notes,
    deliveredBy: toUserId(row.delivered_by),
    deliveredAt: row.delivered_at,
  };
}

function toLine(row: {
  id: string;
  delivery_id: string;
  order_line_id: string;
  quantity: string;
  unit_cost: string | null;
}): SalesDeliveryLine {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    orderLineId: row.order_line_id,
    quantity: trimDecimal(row.quantity),
    unitCost: row.unit_cost === null ? null : trimDecimal(row.unit_cost),
  };
}
