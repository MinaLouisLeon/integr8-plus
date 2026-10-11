import { compareDecimals, formatSalesOrderReference, salesOrderOpen } from '@integr8/core';
import { addDecimals, type SalesOrder, type TenantTransaction, type WorkOrder } from '@integr8/db';
import { isFeatureEnabled } from '../../http/features.js';
import type { RequestContext } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';

/**
 * Where sales orders meet jobs (CRM/ERP plan, phase S1; ADR-0006). These are
 * the hooks the job routes, the parts routes and the phone's sync call; they
 * never import the order routes, so nothing here goes round in a circle.
 *
 * - A part used on a job sees only what is **available**: on-hand less what
 *   is reserved for orders the job is not delivering.
 * - A part used on a job linked to an order counts towards that order's
 *   lines for the item and releases the reservation it fulfils.
 * - A linked job completing delivers every line that is not stock.
 */

/** The open orders a job delivers, oldest link first; none when the module is off. */
export async function openOrdersOf(tx: TenantTransaction, job: WorkOrder): Promise<SalesOrder[]> {
  if (!(await isFeatureEnabled(tx.tenantId, 'sales'))) {
    return [];
  }
  return (await tx.salesOrders.ordersOfWorkOrder(job.id)).filter((order) =>
    salesOrderOpen(order.status),
  );
}

/**
 * What this job may take of an item at a location: what is held, less what
 * other orders have reserved there. Never below zero.
 */
export async function availableForJob(
  tx: TenantTransaction,
  job: WorkOrder,
  itemId: string,
  locationId: string,
  held: string,
): Promise<{ available: string; reservedElsewhere: string }> {
  if (!(await isFeatureEnabled(tx.tenantId, 'sales'))) {
    return { available: held, reservedElsewhere: '0' };
  }
  const linked = (await tx.salesOrders.ordersOfWorkOrder(job.id)).map((order) => order.id);
  const reservedElsewhere = await tx.salesOrders.reservedElsewhere(itemId, locationId, linked);
  const available = addDecimals(held, `-${reservedElsewhere}`);
  return {
    available: compareDecimals(available, '0') < 0 ? '0' : available,
    reservedElsewhere,
  };
}

/**
 * A part used (or a bought-in item recorded) on the job: delivered against
 * the orders the job is linked to, first linked first, as far as they asked
 * for the item. Anything beyond that was simply used on the job.
 */
export async function deliverForJob(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
  itemId: string,
  quantity: string,
): Promise<void> {
  let remaining = quantity;
  for (const order of await openOrdersOf(tx, job)) {
    if (compareDecimals(remaining, '0') <= 0) {
      return;
    }
    const consumed = await tx.salesOrders.consume(order.id, itemId, remaining);
    if (consumed === '0') {
      continue;
    }
    remaining = addDecimals(remaining, `-${consumed}`);
    const settled = await tx.salesOrders.refreshStatus(order.id);
    await audit(tx, context, 'sales_order.delivered', 'sales_order', order.id, {
      reference: formatSalesOrderReference(order.reference),
      workOrderId: job.id,
      itemId,
      quantity: consumed,
      status: settled.status,
    });
  }
}

/** A linked job completed: its orders' service and other non-stock lines are delivered with it. */
export async function deliverOnCompletion(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
): Promise<void> {
  for (const order of await openOrdersOf(tx, job)) {
    const delivered = await tx.salesOrders.fulfilNonStockLines(order.id);
    const settled = await tx.salesOrders.refreshStatus(order.id);
    if (delivered > 0 || settled.status !== order.status) {
      await audit(tx, context, 'sales_order.job_completed', 'sales_order', order.id, {
        reference: formatSalesOrderReference(order.reference),
        workOrderId: job.id,
        linesDelivered: delivered,
        status: settled.status,
      });
    }
  }
}
