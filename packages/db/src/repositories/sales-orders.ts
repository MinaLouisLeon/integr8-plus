import {
  type SalesOrderStatus,
  type Unit,
  type UserId,
  parseSalesReference,
  salesOrderOpen,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpSalesOrdersTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import type { Address } from './customers.js';
import { prefixQuery } from './customers.js';
import {
  addDecimals,
  blankToNull,
  type DocumentTotals,
  documentTotals,
  type LineRow,
  type QuoteLine,
  type QuoteLineInput,
  toAddress,
  toLine,
} from './sales-quotes.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Sales orders (CRM/ERP plan, phase S1; ADR-0006).
 *
 * An order is a quote the customer accepted, or one drafted directly. It is
 * numbered per company on creation and frozen when confirmed: the customer's
 * name and address are copied onto it and its lines stop changing (trigger
 * `erp_sales_order_lines_guard`); from then on only what is reserved and
 * fulfilled moves. Reservations are a soft promise on the line — on-hand is
 * never touched — and every quantity is `numeric(20,4)` computed in SQL.
 */

export interface SalesOrder {
  id: string;
  reference: number;
  quoteId: string | null;
  customerId: string;
  siteId: string | null;
  contactId: string | null;
  status: SalesOrderStatus;
  title: string;
  currencyCode: string;
  notes: string | null;
  internalNotes: string | null;
  /** Where stock lines were reserved when confirmed; null while a draft. */
  reserveLocationId: string | null;
  /** The customer as the confirmed order names them; null while a draft. */
  customerName: string | null;
  customerAddress: Address | null;
  confirmedBy: UserId | null;
  confirmedAt: Date | null;
  fulfilledAt: Date | null;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesOrderLine extends QuoteLine {
  /** Held for this line at `reserveLocationId` while the order is open. */
  quantityReserved: string;
  reserveLocationId: string | null;
  /** Delivered: parts used on linked jobs, or the linked job that did the work completed. */
  quantityFulfilled: string;
  /** What is neither reserved nor delivered: `quantity − reserved − fulfilled`, never below zero. */
  shortfall: string;
}

export interface SalesOrderInput {
  customerId: string;
  siteId?: string | null;
  contactId?: string | null;
  quoteId?: string | null;
  title: string;
  currencyCode: string;
  notes?: string | null;
  internalNotes?: string | null;
}

export interface SalesOrderQuery {
  /** Words from the title or customer name, or a reference such as `SO-000123`. */
  text?: string;
  statuses?: readonly SalesOrderStatus[];
  customerId?: string;
  after?: { createdAt: Date; id: string };
  limit?: number;
}

export interface SalesOrderPage {
  items: SalesOrder[];
  next: { createdAt: Date; id: string } | undefined;
}

export type SalesOrderRefusal = 'not_found' | 'version_conflict';

export interface OrderWorkOrderLink {
  workOrderId: string;
  linkedBy: UserId;
  linkedAt: Date;
}

/** How much of an item is promised at a location, across every open order. */
export interface Reservation {
  itemId: string;
  locationId: string;
  reserved: string;
}

/** A stock line of an open order that the location could not cover: what to buy. */
export interface ShortLine {
  orderId: string;
  reference: number;
  title: string;
  lineId: string;
  itemId: string;
  description: string;
  unit: Unit;
  locationId: string | null;
  shortfall: string;
}

interface OrderLineRow extends LineRow {
  quantity_reserved: string;
  reserve_location_id: string | null;
  quantity_fulfilled: string;
  shortfall: string;
}

const ORDER_LINE_MATH = sql`
  round(l.quantity * l.unit_price, 4) as gross,
  round(round(l.quantity * l.unit_price, 4) * l.discount_bp / 10000, 4) as discount,
  round(round(l.quantity * l.unit_price, 4) - round(round(l.quantity * l.unit_price, 4) * l.discount_bp / 10000, 4), 4) as net,
  round((round(l.quantity * l.unit_price, 4) - round(round(l.quantity * l.unit_price, 4) * l.discount_bp / 10000, 4)) * l.tax_rate_bp / 10000, 4) as tax,
  greatest(l.quantity - l.quantity_reserved - l.quantity_fulfilled, 0) as shortfall
`;

export class SalesOrdersRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async createOrder(
    input: SalesOrderInput,
    lines: readonly QuoteLineInput[],
    createdBy: UserId | string,
  ): Promise<SalesOrder> {
    const row = await this.db
      .insertInto('erp_sales_orders')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        quote_id: input.quoteId ?? null,
        customer_id: input.customerId,
        site_id: input.siteId ?? null,
        contact_id: input.contactId ?? null,
        title: input.title.trim(),
        currency_code: input.currencyCode,
        notes: blankToNull(input.notes),
        internal_notes: blankToNull(input.internalNotes),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#writeLines(row.id, lines);
    return toOrder(row);
  }

  async findOrder(orderId: string): Promise<SalesOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_sales_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  /** Locks the order for the rest of the transaction: one confirmation, one reservation run at a time. */
  async lockOrder(orderId: string): Promise<SalesOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_sales_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  async findOrders(orderIds: readonly string[]): Promise<SalesOrder[]> {
    if (orderIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_sales_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(orderIds)])
      .execute();
    return rows.map(toOrder);
  }

  async findByQuote(quoteId: string): Promise<SalesOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_sales_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('quote_id', '=', quoteId)
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  async listOrders(query: SalesOrderQuery = {}): Promise<SalesOrderPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.db
      .selectFrom('erp_sales_orders')
      .selectAll('erp_sales_orders')
      .where('erp_sales_orders.tenant_id', '=', this.tenantId);
    if (query.text !== undefined && query.text.trim() !== '') {
      const reference = parseSalesReference(query.text);
      if (reference !== undefined) {
        select = select.where('erp_sales_orders.reference', '=', reference);
      } else {
        const words = prefixQuery(query.text);
        if (words !== undefined) {
          select = select.where((eb) =>
            eb.or([
              eb(
                sql`to_tsvector('simple', erp_sales_orders.title || ' ' || coalesce(erp_sales_orders.customer_name, ''))`,
                '@@',
                sql`to_tsquery('simple', ${words})`,
              ),
              eb.exists(
                eb
                  .selectFrom('customers')
                  .select(sql`1`.as('one'))
                  .where('customers.tenant_id', '=', this.tenantId)
                  .whereRef('customers.id', '=', 'erp_sales_orders.customer_id')
                  .where(sql<boolean>`customers.search @@ to_tsquery('simple', ${words})`),
              ),
            ]),
          );
        }
      }
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('erp_sales_orders.status', 'in', [...query.statuses]);
    }
    if (query.customerId !== undefined) {
      select = select.where('erp_sales_orders.customer_id', '=', query.customerId);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(erp_sales_orders.created_at, erp_sales_orders.id) < (${query.after.createdAt}, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy('erp_sales_orders.created_at', 'desc')
      .orderBy('erp_sales_orders.id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toOrder);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }

  async orderLines(orderId: string): Promise<SalesOrderLine[]> {
    const { rows } = await sql<OrderLineRow>`
      select l.*, ${ORDER_LINE_MATH}
        from erp_sales_order_lines l
       where l.tenant_id = ${this.tenantId} and l.order_id = ${orderId}
       order by l.position
    `.execute(this.db);
    return rows.map(toOrderLine);
  }

  async orderTotals(orderId: string): Promise<DocumentTotals> {
    return documentTotals(this.db, 'erp_sales_order_lines', 'order_id', this.tenantId, orderId);
  }

  /** Changes a draft, replacing every line when `lines` is given. */
  async updateDraft(
    orderId: string,
    expectedVersion: number,
    input: Partial<Omit<SalesOrderInput, 'currencyCode' | 'quoteId'>>,
    lines: readonly QuoteLineInput[] | undefined,
  ): Promise<SalesOrder | SalesOrderRefusal | 'not_draft'> {
    const current = await this.lockOrder(orderId);
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
        .deleteFrom('erp_sales_order_lines')
        .where('tenant_id', '=', this.tenantId)
        .where('order_id', '=', orderId)
        .execute();
      await this.#writeLines(orderId, lines);
    }
    const row = await this.db
      .updateTable('erp_sales_orders')
      .set({
        ...(input.customerId === undefined ? {} : { customer_id: input.customerId }),
        ...(input.siteId === undefined ? {} : { site_id: input.siteId }),
        ...(input.contactId === undefined ? {} : { contact_id: input.contactId }),
        ...(input.title === undefined ? {} : { title: input.title.trim() }),
        ...(input.notes === undefined ? {} : { notes: blankToNull(input.notes) }),
        ...(input.internalNotes === undefined
          ? {}
          : { internal_notes: blankToNull(input.internalNotes) }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOrder(row);
  }

  /**
   * Confirms a draft: freezes the customer onto it and records who, when and
   * where stock is reserved. The caller checked the status and then runs
   * `reserve`; the pairing constraints check the bookkeeping.
   */
  async confirm(
    orderId: string,
    expectedVersion: number,
    confirmation: {
      confirmedBy: UserId | string;
      customerName: string;
      customerAddress: Address;
      reserveLocationId: string | null;
    },
  ): Promise<SalesOrder | SalesOrderRefusal> {
    const row = await this.db
      .updateTable('erp_sales_orders')
      .set({
        status: 'confirmed',
        confirmed_by: toUserId(confirmation.confirmedBy),
        confirmed_at: sql<Date>`now()`,
        customer_name: confirmation.customerName,
        customer_address: sql`${JSON.stringify(confirmation.customerAddress)}::jsonb`,
        reserve_location_id: confirmation.reserveLocationId,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? await this.#refusal(orderId) : toOrder(row);
  }

  /**
   * Runs the reservation for every stock line of an open order at one
   * location (ADR-0006): each line holds what is still due to the customer,
   * or what the location has left once every other reservation there is
   * counted — whichever is less, never below zero. Earlier reservations of
   * this order are released first, so moving to another location is one
   * call. Each balance is locked while its line is decided.
   */
  async reserve(orderId: string, locationId: string): Promise<SalesOrderLine[]> {
    await this.release(orderId);
    await this.db
      .updateTable('erp_sales_orders')
      .set({ reserve_location_id: locationId, version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .execute();
    const stockLines = await this.db
      .selectFrom('erp_sales_order_lines')
      .innerJoin('erp_items', (join) =>
        join
          .onRef('erp_items.tenant_id', '=', 'erp_sales_order_lines.tenant_id')
          .onRef('erp_items.id', '=', 'erp_sales_order_lines.item_id'),
      )
      .select(['erp_sales_order_lines.id as id', 'erp_sales_order_lines.item_id as item_id'])
      .where('erp_sales_order_lines.tenant_id', '=', this.tenantId)
      .where('erp_sales_order_lines.order_id', '=', orderId)
      .where('erp_items.kind', '=', 'stock_item')
      .orderBy('erp_sales_order_lines.position')
      .execute();
    for (const line of stockLines) {
      // The balance's lock, through the same security-definer function the
      // ledger uses: nobody moves this stock while the line is decided.
      const { rows } = await sql<{ held: string }>`
        select erp_stock_lock_balance(${this.tenantId}::uuid, ${line.item_id}::uuid, ${locationId}::uuid)::text as held
      `.execute(this.db);
      const held = rows[0]!.held;
      await sql`
        update erp_sales_order_lines l
           set reserve_location_id = ${locationId}::uuid,
               quantity_reserved = greatest(0, least(
                 l.quantity - l.quantity_fulfilled,
                 ${held}::numeric - coalesce((
                   select sum(o.quantity_reserved)
                     from erp_sales_order_lines o
                    where o.tenant_id = l.tenant_id
                      and o.item_id = l.item_id
                      and o.reserve_location_id = ${locationId}::uuid
                      and o.id <> l.id), 0)))
         where l.tenant_id = ${this.tenantId} and l.id = ${line.id}
      `.execute(this.db);
    }
    return this.orderLines(orderId);
  }

  /** Lets go of everything the order holds. */
  async release(orderId: string): Promise<void> {
    await this.db
      .updateTable('erp_sales_order_lines')
      .set({ quantity_reserved: '0' })
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .where('quantity_reserved', '>', '0')
      .execute();
  }

  /**
   * How much of an item at a location is promised to orders other than
   * `excludingOrderIds`: what a job not linked to those orders may not take.
   */
  async reservedElsewhere(
    itemId: string,
    locationId: string,
    excludingOrderIds: readonly string[],
  ): Promise<string> {
    let select = this.db
      .selectFrom('erp_sales_order_lines')
      .select(sql<string>`coalesce(sum(quantity_reserved), 0)::text`.as('reserved'))
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .where('reserve_location_id', '=', locationId)
      .where('quantity_reserved', '>', '0');
    if (excludingOrderIds.length > 0) {
      select = select.where('order_id', 'not in', [...excludingOrderIds]);
    }
    const row = await select.executeTakeFirstOrThrow();
    return trimDecimal(row.reserved);
  }

  /** What is reserved where, summed over every open order, for the balances people see. */
  async reservations(query: { itemId?: string; locationId?: string } = {}): Promise<Reservation[]> {
    let select = this.db
      .selectFrom('erp_sales_order_lines')
      .select([
        'item_id',
        'reserve_location_id',
        sql<string>`sum(quantity_reserved)::text`.as('reserved'),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('quantity_reserved', '>', '0')
      .where('item_id', 'is not', null)
      .where('reserve_location_id', 'is not', null)
      .groupBy(['item_id', 'reserve_location_id']);
    if (query.itemId !== undefined) {
      select = select.where('item_id', '=', query.itemId);
    }
    if (query.locationId !== undefined) {
      select = select.where('reserve_location_id', '=', query.locationId);
    }
    const rows = await select.execute();
    return rows.map((row) => ({
      itemId: row.item_id!,
      locationId: row.reserve_location_id!,
      reserved: trimDecimal(row.reserved),
    }));
  }

  /**
   * A part used on a job linked to this order: counts towards the lines for
   * that item, first to last, and lets go of the reservation it fulfils.
   * Returns how much of `quantity` the order accounted for; the rest was more
   * than the order asked for.
   */
  async consume(orderId: string, itemId: string, quantity: string): Promise<string> {
    const lines = await this.db
      .selectFrom('erp_sales_order_lines')
      .select(['id'])
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .where('item_id', '=', itemId)
      .where(sql<boolean>`quantity_fulfilled < quantity`)
      .orderBy('position')
      .forUpdate()
      .execute();
    let remaining = quantity;
    let consumed = '0';
    for (const line of lines) {
      if (trimDecimal(remaining) === '0') {
        break;
      }
      const { rows } = await sql<{ take: string }>`
        select least(${remaining}::numeric, quantity - quantity_fulfilled)::text as take
          from erp_sales_order_lines
         where tenant_id = ${this.tenantId} and id = ${line.id}
      `.execute(this.db);
      const take = trimDecimal(rows[0]!.take);
      await sql`
        update erp_sales_order_lines
           set quantity_fulfilled = quantity_fulfilled + ${take}::numeric,
               quantity_reserved = least(quantity_reserved, quantity - quantity_fulfilled - ${take}::numeric)
         where tenant_id = ${this.tenantId} and id = ${line.id}
      `.execute(this.db);
      consumed = addDecimals(consumed, take);
      remaining = addDecimals(remaining, `-${take}`);
    }
    return consumed;
  }

  /**
   * A linked job completed: every line that is not stock — a service, a
   * bought-in item, a line written by hand — is delivered with it. Stock
   * lines are delivered by the parts used on the job.
   */
  async fulfilNonStockLines(orderId: string): Promise<number> {
    const result = await sql`
      update erp_sales_order_lines l
         set quantity_fulfilled = l.quantity, quantity_reserved = 0
       where l.tenant_id = ${this.tenantId}
         and l.order_id = ${orderId}
         and l.quantity_fulfilled < l.quantity
         and (l.item_id is null or exists (
           select 1 from erp_items i
            where i.tenant_id = l.tenant_id and i.id = l.item_id and i.kind <> 'stock_item'))
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  /**
   * Settles the status of an open order from its lines: fulfilled when every
   * line is delivered, partially fulfilled when any is, confirmed otherwise.
   */
  async refreshStatus(orderId: string): Promise<SalesOrder> {
    const current = await this.lockOrder(orderId);
    if (current === undefined) {
      throw new Error('refreshStatus: no such order');
    }
    if (!salesOrderOpen(current.status)) {
      return current;
    }
    const row = await this.db
      .updateTable('erp_sales_orders')
      .set({
        status: sql<SalesOrderStatus>`case
          when not exists (select 1 from erp_sales_order_lines l where l.tenant_id = erp_sales_orders.tenant_id and l.order_id = erp_sales_orders.id and l.quantity_fulfilled < l.quantity)
            then 'fulfilled'
          when exists (select 1 from erp_sales_order_lines l where l.tenant_id = erp_sales_orders.tenant_id and l.order_id = erp_sales_orders.id and l.quantity_fulfilled > 0)
            then 'partially_fulfilled'
          else 'confirmed' end`,
        fulfilled_at: sql<Date | null>`case
          when not exists (select 1 from erp_sales_order_lines l where l.tenant_id = erp_sales_orders.tenant_id and l.order_id = erp_sales_orders.id and l.quantity_fulfilled < l.quantity)
            then coalesce(fulfilled_at, now())
          else null end`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (row.status === 'fulfilled') {
      await this.release(orderId);
    }
    return toOrder(row);
  }

  async cancel(
    orderId: string,
    expectedVersion: number,
    cancelledBy: UserId | string,
    reason: string | null,
  ): Promise<SalesOrder | SalesOrderRefusal> {
    const row = await this.db
      .updateTable('erp_sales_orders')
      .set({
        status: 'cancelled',
        cancelled_by: toUserId(cancelledBy),
        cancelled_at: sql<Date>`now()`,
        cancel_reason: blankToNull(reason),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      return this.#refusal(orderId);
    }
    await this.release(orderId);
    return toOrder(row);
  }

  /** Stock lines of open orders the location could not cover: what to buy, most recent order first. */
  async shortLines(limit = 50): Promise<ShortLine[]> {
    const { rows } = await sql<{
      order_id: string;
      reference: number;
      title: string;
      line_id: string;
      item_id: string;
      description: string;
      unit: Unit;
      location_id: string | null;
      shortfall: string;
    }>`
      select o.id as order_id, o.reference, o.title, l.id as line_id, l.item_id, l.description, l.unit,
             l.reserve_location_id as location_id,
             (l.quantity - l.quantity_reserved - l.quantity_fulfilled)::text as shortfall
        from erp_sales_order_lines l
        join erp_sales_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
        join erp_items i on i.tenant_id = l.tenant_id and i.id = l.item_id
       where l.tenant_id = ${this.tenantId}
         and o.status in ('confirmed', 'partially_fulfilled')
         and i.kind = 'stock_item'
         and l.quantity - l.quantity_reserved - l.quantity_fulfilled > 0
       order by o.created_at desc, l.position
       limit ${Math.min(Math.max(limit, 1), 500)}
    `.execute(this.db);
    return rows.map((row) => ({
      orderId: row.order_id,
      reference: row.reference,
      title: row.title,
      lineId: row.line_id,
      itemId: row.item_id,
      description: row.description,
      unit: row.unit,
      locationId: row.location_id,
      shortfall: trimDecimal(row.shortfall),
    }));
  }

  // -------------------------------------------------------------------------
  // The jobs that deliver an order
  // -------------------------------------------------------------------------

  async linkWorkOrder(
    orderId: string,
    workOrderId: string,
    linkedBy: UserId | string,
  ): Promise<void> {
    await this.db
      .insertInto('erp_sales_order_work_orders')
      .values({
        tenant_id: this.tenantId,
        order_id: orderId,
        work_order_id: workOrderId,
        linked_by: toUserId(linkedBy),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async unlinkWorkOrder(orderId: string, workOrderId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('erp_sales_order_work_orders')
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .where('work_order_id', '=', workOrderId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async workOrderLinks(orderId: string): Promise<OrderWorkOrderLink[]> {
    const rows = await this.db
      .selectFrom('erp_sales_order_work_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .orderBy('linked_at')
      .execute();
    return rows.map((row) => ({
      workOrderId: row.work_order_id,
      linkedBy: toUserId(row.linked_by),
      linkedAt: row.linked_at,
    }));
  }

  /** The orders a job delivers, oldest link first. */
  async ordersOfWorkOrder(workOrderId: string): Promise<SalesOrder[]> {
    const rows = await this.db
      .selectFrom('erp_sales_order_work_orders')
      .innerJoin('erp_sales_orders', (join) =>
        join
          .onRef('erp_sales_orders.tenant_id', '=', 'erp_sales_order_work_orders.tenant_id')
          .onRef('erp_sales_orders.id', '=', 'erp_sales_order_work_orders.order_id'),
      )
      .selectAll('erp_sales_orders')
      .where('erp_sales_order_work_orders.tenant_id', '=', this.tenantId)
      .where('erp_sales_order_work_orders.work_order_id', '=', workOrderId)
      .orderBy('erp_sales_order_work_orders.linked_at')
      .execute();
    return rows.map(toOrder);
  }

  async #refusal(orderId: string): Promise<SalesOrderRefusal> {
    return (await this.findOrder(orderId)) === undefined ? 'not_found' : 'version_conflict';
  }

  async #writeLines(orderId: string, lines: readonly QuoteLineInput[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('erp_sales_order_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: this.tenantId,
          order_id: orderId,
          position: index + 1,
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

function toOrderLine(row: OrderLineRow): SalesOrderLine {
  return {
    ...toLine(row),
    quantityReserved: trimDecimal(row.quantity_reserved),
    reserveLocationId: row.reserve_location_id,
    quantityFulfilled: trimDecimal(row.quantity_fulfilled),
    shortfall: trimDecimal(row.shortfall),
  };
}

function toOrder(row: Selectable<ErpSalesOrdersTable>): SalesOrder {
  return {
    id: row.id,
    reference: row.reference,
    quoteId: row.quote_id,
    customerId: row.customer_id,
    siteId: row.site_id,
    contactId: row.contact_id,
    status: row.status,
    title: row.title,
    currencyCode: row.currency_code,
    notes: row.notes,
    internalNotes: row.internal_notes,
    reserveLocationId: row.reserve_location_id,
    customerName: row.customer_name,
    customerAddress: toAddress(row.customer_address),
    confirmedBy: row.confirmed_by === null ? null : toUserId(row.confirmed_by),
    confirmedAt: row.confirmed_at,
    fulfilledAt: row.fulfilled_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
