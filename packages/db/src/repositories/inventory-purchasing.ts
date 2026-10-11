import {
  type PurchaseOrderStatus,
  type SupplierStatus,
  type UserId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  ErpGoodsReceiptLinesTable,
  ErpGoodsReceiptsTable,
  ErpPurchaseOrderLinesTable,
  ErpPurchaseOrdersTable,
  ErpSuppliersTable,
} from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import type { Address } from './customers.js';
import { prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Suppliers, purchase orders and goods receipts (CRM/ERP plan, phase E2).
 *
 * Money is `numeric(20,4)` end to end: line and order totals are summed in
 * SQL and come back as decimal strings, rounded half-up to four places once.
 * Posting the stock a receipt brings in is the stock repository's job; this
 * one records the documents and keeps "how much of the order has arrived".
 */

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export interface Supplier {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  taxReference: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  address: Address;
  status: SupplierStatus;
  notes: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierInput {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  taxReference?: string | null;
  paymentTerms?: string | null;
  leadTimeDays?: number | null;
  address?: Partial<Address>;
  status?: SupplierStatus;
  notes?: string | null;
}

export interface SupplierQuery {
  text?: string;
  statuses?: readonly SupplierStatus[];
  after?: { name: string; id: string };
  limit?: number;
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export interface PurchaseOrderLine {
  id: string;
  position: number;
  itemId: string;
  description: string;
  quantityOrdered: string;
  quantityReceived: string;
  unitPrice: string;
  taxRateBp: number;
  /** `quantityOrdered × unitPrice`, rounded to four places. */
  subtotal: string;
  /** The tax on the subtotal, rounded to four places. */
  tax: string;
}

export interface PurchaseOrderTotals {
  subtotal: string;
  tax: string;
  total: string;
}

export interface PurchaseOrder {
  id: string;
  reference: number;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  currencyCode: string;
  /** `YYYY-MM-DD`. */
  expectedDate: string | null;
  deliveryLocationId: string | null;
  notes: string | null;
  approvedBy: UserId | null;
  approvedAt: Date | null;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseOrderLineInput {
  itemId: string;
  description: string;
  quantityOrdered: string;
  unitPrice: string;
  taxRateBp?: number;
}

export interface PurchaseOrderInput {
  supplierId: string;
  supplierName: string;
  currencyCode: string;
  expectedDate?: string | null;
  deliveryLocationId?: string | null;
  notes?: string | null;
}

export interface PurchaseOrderQuery {
  /** Words from the supplier's name, or a reference such as `PO-000123` or `123`. */
  text?: string;
  statuses?: readonly PurchaseOrderStatus[];
  supplierId?: string;
  after?: { createdAt: Date; id: string };
  limit?: number;
}

export interface PurchaseOrderPage {
  items: PurchaseOrder[];
  next: { createdAt: Date; id: string } | undefined;
}

export type PurchaseRefusal = 'not_found' | 'version_conflict';

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export interface GoodsReceipt {
  id: string;
  orderId: string;
  locationId: string;
  supplierNote: string | null;
  notes: string | null;
  receivedBy: UserId;
  receivedAt: Date;
  lines: GoodsReceiptLine[];
}

export interface GoodsReceiptLine {
  id: string;
  orderLineId: string;
  quantity: string;
  unitCost: string;
  returnedQuantity: string;
}

/** A reference as someone might type it: `PO-000123`, `po123`, `123`. */
export function parsePurchaseOrderReference(text: string): number | undefined {
  const match = /^\s*(?:po[-\s]?)?0*(\d{1,9})\s*$/iu.exec(text);
  return match === null ? undefined : Number(match[1]);
}

export class InventoryPurchasingRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------

  async createSupplier(input: SupplierInput, createdBy: UserId | string): Promise<Supplier> {
    const row = await this.db
      .insertInto('erp_suppliers')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...supplierColumns(input),
        name: input.name.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSupplier(row);
  }

  async findSupplier(supplierId: string): Promise<Supplier | undefined> {
    const row = await this.db
      .selectFrom('erp_suppliers')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', supplierId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSupplier(row);
  }

  async findSuppliers(supplierIds: readonly string[]): Promise<Supplier[]> {
    if (supplierIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_suppliers')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(supplierIds)])
        .execute()
    ).map(toSupplier);
  }

  async updateSupplier(
    supplierId: string,
    expectedVersion: number,
    input: Partial<SupplierInput>,
  ): Promise<Supplier | PurchaseRefusal> {
    const row = await this.db
      .updateTable('erp_suppliers')
      .set({ ...supplierColumns(input), version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', supplierId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return toSupplier(row);
    }
    return (await this.findSupplier(supplierId)) === undefined ? 'not_found' : 'version_conflict';
  }

  /** Alphabetical, a page at a time. */
  async listSuppliers(
    query: SupplierQuery = {},
  ): Promise<{ items: Supplier[]; next: { name: string; id: string } | undefined }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let select = this.db
      .selectFrom('erp_suppliers')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    const words = query.text === undefined ? undefined : prefixQuery(query.text);
    if (words !== undefined) {
      select = select.where(sql<boolean>`search @@ to_tsquery('simple', ${words})`);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(lower(name), id) > (lower(${query.after.name}), ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toSupplier);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined ? { name: last.name, id: last.id } : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Purchase orders
  // -------------------------------------------------------------------------

  async createOrder(
    input: PurchaseOrderInput,
    lines: readonly PurchaseOrderLineInput[],
    createdBy: UserId | string,
  ): Promise<PurchaseOrder> {
    const row = await this.db
      .insertInto('erp_purchase_orders')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        supplier_id: input.supplierId,
        supplier_name: input.supplierName.trim(),
        currency_code: input.currencyCode,
        expected_date: input.expectedDate ?? null,
        delivery_location_id: input.deliveryLocationId ?? null,
        notes: blankToNull(input.notes) ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#writeLines(row.id, lines);
    return toOrder(row);
  }

  async findOrder(orderId: string): Promise<PurchaseOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_purchase_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  /** The order, locked until the transaction ends: receipts against it queue up. */
  async lockOrder(orderId: string): Promise<PurchaseOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_purchase_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  async findOrders(orderIds: readonly string[]): Promise<PurchaseOrder[]> {
    if (orderIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_purchase_orders')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(orderIds)])
        .execute()
    ).map(toOrder);
  }

  /** Newest first, a page at a time. */
  async listOrders(query: PurchaseOrderQuery = {}): Promise<PurchaseOrderPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.db
      .selectFrom('erp_purchase_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.text !== undefined) {
      const reference = parsePurchaseOrderReference(query.text);
      const words = prefixQuery(query.text);
      select = select.where((eb) =>
        eb.or([
          ...(reference === undefined ? [] : [eb('reference', '=', reference)]),
          ...(words === undefined
            ? []
            : [
                sql<boolean>`to_tsvector('simple', supplier_name) @@ to_tsquery('simple', ${words})`,
              ]),
        ]),
      );
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.supplierId !== undefined) {
      select = select.where('supplier_id', '=', query.supplierId);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy(sql`date_trunc('milliseconds', created_at)`, 'desc')
      .orderBy('id', 'desc')
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

  /** The lines, in order, each with its subtotal and tax computed in SQL. */
  async orderLines(orderId: string): Promise<PurchaseOrderLine[]> {
    const rows = await this.db
      .selectFrom('erp_purchase_order_lines')
      .selectAll()
      .select([
        sql<string>`round(quantity_ordered * unit_price, 4)::text`.as('subtotal'),
        sql<string>`round(quantity_ordered * unit_price * tax_rate_bp / 10000.0, 4)::text`.as(
          'tax',
        ),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .orderBy('position')
      .execute();
    return rows.map(toLine);
  }

  async findLines(lineIds: readonly string[]): Promise<PurchaseOrderLine[]> {
    if (lineIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_purchase_order_lines')
      .selectAll()
      .select([
        sql<string>`round(quantity_ordered * unit_price, 4)::text`.as('subtotal'),
        sql<string>`round(quantity_ordered * unit_price * tax_rate_bp / 10000.0, 4)::text`.as(
          'tax',
        ),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(lineIds)])
      .execute();
    return rows.map(toLine);
  }

  /** Subtotal, tax and total of an order, summed in SQL. */
  async orderTotals(orderId: string): Promise<PurchaseOrderTotals> {
    const row = await this.db
      .selectFrom('erp_purchase_order_lines')
      .select([
        sql<string>`coalesce(sum(round(quantity_ordered * unit_price, 4)), 0)::text`.as('subtotal'),
        sql<string>`coalesce(sum(round(quantity_ordered * unit_price * tax_rate_bp / 10000.0, 4)), 0)::text`.as(
          'tax',
        ),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();
    const total = await sql<{ total: string }>`
      select (${row.subtotal}::numeric + ${row.tax}::numeric)::text as total
    `.execute(this.db);
    return {
      subtotal: trimDecimal(row.subtotal),
      tax: trimDecimal(row.tax),
      total: trimDecimal(total.rows[0]!.total),
    };
  }

  /** Changes a draft order's details and replaces its lines, against its version. */
  async updateDraft(
    orderId: string,
    expectedVersion: number,
    input: Partial<Omit<PurchaseOrderInput, 'currencyCode'>>,
    lines: readonly PurchaseOrderLineInput[] | undefined,
  ): Promise<PurchaseOrder | PurchaseRefusal | 'not_draft'> {
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
        .deleteFrom('erp_purchase_order_lines')
        .where('tenant_id', '=', this.tenantId)
        .where('order_id', '=', orderId)
        .execute();
      await this.#writeLines(orderId, lines);
    }
    const row = await this.db
      .updateTable('erp_purchase_orders')
      .set({
        ...(input.supplierId === undefined ? {} : { supplier_id: input.supplierId }),
        ...(input.supplierName === undefined ? {} : { supplier_name: input.supplierName.trim() }),
        ...(input.expectedDate === undefined ? {} : { expected_date: input.expectedDate }),
        ...(input.deliveryLocationId === undefined
          ? {}
          : { delivery_location_id: input.deliveryLocationId }),
        ...(input.notes === undefined ? {} : { notes: blankToNull(input.notes) ?? null }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOrder(row);
  }

  /**
   * Moves an order to another status, against its version, recording who and
   * when for approvals and cancellations. The caller has checked the move is
   * allowed; the status pairing constraints check the bookkeeping.
   */
  async setStatus(
    orderId: string,
    expectedVersion: number,
    change:
      /** With an `actorId`, this is the approval; without, a return has brought a received order back to approved. */
      | { status: 'approved'; actorId?: UserId | string }
      | { status: 'cancelled'; actorId: UserId | string; reason: string | null }
      | { status: 'partially_received' | 'received' },
  ): Promise<PurchaseOrder | PurchaseRefusal> {
    const row = await this.db
      .updateTable('erp_purchase_orders')
      .set({
        status: change.status,
        ...(change.status === 'approved' && change.actorId !== undefined
          ? { approved_by: toUserId(change.actorId), approved_at: sql<Date>`now()` }
          : {}),
        ...(change.status === 'cancelled'
          ? {
              cancelled_by: toUserId(change.actorId),
              cancelled_at: sql<Date>`now()`,
              cancel_reason: change.reason,
            }
          : {}),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', orderId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return toOrder(row);
    }
    return (await this.findOrder(orderId)) === undefined ? 'not_found' : 'version_conflict';
  }

  // -------------------------------------------------------------------------
  // Goods receipts
  // -------------------------------------------------------------------------

  /**
   * Records a receipt and adds each line's quantity to its order line's
   * `quantity_received`. The check constraint refuses more than was ordered.
   * The caller holds the order's lock, posts the stock, and sets the order's
   * status from what `receivedState` says.
   */
  async recordReceipt(
    input: {
      orderId: string;
      locationId: string;
      supplierNote: string | null;
      notes: string | null;
      receivedBy: UserId | string;
    },
    lines: readonly { orderLineId: string; quantity: string; unitCost: string }[],
  ): Promise<GoodsReceipt> {
    const receipt = await this.db
      .insertInto('erp_goods_receipts')
      .values({
        tenant_id: this.tenantId,
        order_id: input.orderId,
        location_id: input.locationId,
        supplier_note: blankToNull(input.supplierNote) ?? null,
        notes: blankToNull(input.notes) ?? null,
        received_by: toUserId(input.receivedBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const written = await this.db
      .insertInto('erp_goods_receipt_lines')
      .values(
        lines.map((line) => ({
          tenant_id: this.tenantId,
          receipt_id: receipt.id,
          order_line_id: line.orderLineId,
          quantity: line.quantity,
          unit_cost: line.unitCost,
        })),
      )
      .returningAll()
      .execute();
    for (const line of lines) {
      await this.db
        .updateTable('erp_purchase_order_lines')
        .set({ quantity_received: sql<string>`quantity_received + ${line.quantity}::numeric` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', line.orderLineId)
        .execute();
    }
    return toReceipt(receipt, written);
  }

  /** Records a return against a receipt line and frees that quantity on the order line. */
  async recordReturn(receiptLineId: string, quantity: string): Promise<GoodsReceiptLine> {
    const row = await this.db
      .updateTable('erp_goods_receipt_lines')
      .set({ returned_quantity: sql<string>`returned_quantity + ${quantity}::numeric` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', receiptLineId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.db
      .updateTable('erp_purchase_order_lines')
      .set({ quantity_received: sql<string>`quantity_received - ${quantity}::numeric` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', row.order_line_id)
      .execute();
    return toReceiptLine(row);
  }

  async findReceipt(receiptId: string): Promise<GoodsReceipt | undefined> {
    const row = await this.db
      .selectFrom('erp_goods_receipts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', receiptId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const lines = await this.db
      .selectFrom('erp_goods_receipt_lines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('receipt_id', '=', row.id)
      .execute();
    return toReceipt(row, lines);
  }

  /** An order's receipts, newest first, with their lines. */
  async receiptsFor(orderId: string): Promise<GoodsReceipt[]> {
    const receipts = await this.db
      .selectFrom('erp_goods_receipts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .orderBy('id', 'desc')
      .execute();
    if (receipts.length === 0) {
      return [];
    }
    const lines = await this.db
      .selectFrom('erp_goods_receipt_lines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where(
        'receipt_id',
        'in',
        receipts.map((receipt) => receipt.id),
      )
      .execute();
    return receipts.map((receipt) =>
      toReceipt(
        receipt,
        lines.filter((line) => line.receipt_id === receipt.id),
      ),
    );
  }

  /**
   * Whether every line of an order has arrived in full, some of it has, or
   * none yet — what the order's status should say after a receipt or return.
   */
  async receivedState(orderId: string): Promise<'none' | 'partial' | 'full'> {
    const row = await this.db
      .selectFrom('erp_purchase_order_lines')
      .select([
        sql<boolean>`bool_and(quantity_received >= quantity_ordered)`.as('full'),
        sql<boolean>`bool_or(quantity_received > 0)`.as('some'),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();
    return row.full ? 'full' : row.some ? 'partial' : 'none';
  }

  async #writeLines(orderId: string, lines: readonly PurchaseOrderLineInput[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('erp_purchase_order_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: this.tenantId,
          order_id: orderId,
          position: index + 1,
          item_id: line.itemId,
          description: line.description.trim(),
          quantity_ordered: line.quantityOrdered,
          unit_price: line.unitPrice,
          tax_rate_bp: line.taxRateBp ?? 0,
        })),
      )
      .execute();
  }
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function supplierColumns(input: Partial<SupplierInput>) {
  const address = input.address;
  return {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.contactName === undefined ? {} : { contact_name: blankToNull(input.contactName) }),
    ...(input.email === undefined ? {} : { email: blankToNull(input.email) }),
    ...(input.phone === undefined ? {} : { phone: blankToNull(input.phone) }),
    ...(input.taxReference === undefined ? {} : { tax_reference: blankToNull(input.taxReference) }),
    ...(input.paymentTerms === undefined ? {} : { payment_terms: blankToNull(input.paymentTerms) }),
    ...(input.leadTimeDays === undefined ? {} : { lead_time_days: input.leadTimeDays }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.notes === undefined ? {} : { notes: blankToNull(input.notes) }),
    ...(address === undefined
      ? {}
      : {
          ...(address.line1 === undefined ? {} : { address_line1: blankToNull(address.line1) }),
          ...(address.line2 === undefined ? {} : { address_line2: blankToNull(address.line2) }),
          ...(address.city === undefined ? {} : { city: blankToNull(address.city) }),
          ...(address.region === undefined ? {} : { region: blankToNull(address.region) }),
          ...(address.postcode === undefined ? {} : { postcode: blankToNull(address.postcode) }),
          ...(address.countryCode === undefined
            ? {}
            : { country_code: blankToNull(address.countryCode)?.toUpperCase() ?? null }),
        }),
  };
}

function toSupplier(row: Omit<Selectable<ErpSuppliersTable>, 'search'>): Supplier {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    taxReference: row.tax_reference,
    paymentTerms: row.payment_terms,
    leadTimeDays: row.lead_time_days,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postcode: row.postcode,
      countryCode: row.country_code,
    },
    status: row.status,
    notes: row.notes,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOrder(row: Selectable<ErpPurchaseOrdersTable>): PurchaseOrder {
  return {
    id: row.id,
    reference: row.reference,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    status: row.status,
    currencyCode: row.currency_code,
    expectedDate: toDayString(row.expected_date),
    deliveryLocationId: row.delivery_location_id,
    notes: row.notes,
    approvedBy: row.approved_by === null ? null : toUserId(row.approved_by),
    approvedAt: row.approved_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLine(
  row: Selectable<ErpPurchaseOrderLinesTable> & { subtotal: string; tax: string },
): PurchaseOrderLine {
  return {
    id: row.id,
    position: row.position,
    itemId: row.item_id,
    description: row.description,
    quantityOrdered: trimDecimal(row.quantity_ordered),
    quantityReceived: trimDecimal(row.quantity_received),
    unitPrice: trimDecimal(row.unit_price),
    taxRateBp: row.tax_rate_bp,
    subtotal: trimDecimal(row.subtotal),
    tax: trimDecimal(row.tax),
  };
}

function toReceiptLine(row: Selectable<ErpGoodsReceiptLinesTable>): GoodsReceiptLine {
  return {
    id: row.id,
    orderLineId: row.order_line_id,
    quantity: trimDecimal(row.quantity),
    unitCost: trimDecimal(row.unit_cost),
    returnedQuantity: trimDecimal(row.returned_quantity),
  };
}

function toReceipt(
  row: Selectable<ErpGoodsReceiptsTable>,
  lines: readonly Selectable<ErpGoodsReceiptLinesTable>[],
): GoodsReceipt {
  return {
    id: row.id,
    orderId: row.order_id,
    locationId: row.location_id,
    supplierNote: row.supplier_note,
    notes: row.notes,
    receivedBy: toUserId(row.received_by),
    receivedAt: row.received_at,
    lines: lines.map(toReceiptLine),
  };
}
