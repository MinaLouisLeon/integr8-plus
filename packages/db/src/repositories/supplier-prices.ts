import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpSupplierPricesTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * What suppliers charge (eighth round; ADR-0012): a price per supplier and
 * item, in the supplier's currency, between two days, from a quantity on. A
 * new purchase order line takes the price in force for its quantity on the
 * day it is written; planning and reorder drafts use it too.
 */

export interface SupplierPrice {
  id: string;
  supplierId: string;
  itemId: string;
  currencyCode: string;
  /** The least quantity on one line this price is for. */
  minQuantity: string;
  unitPrice: string;
  /** `YYYY-MM-DD`. */
  validFrom: string;
  validTo: string | null;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierPriceInput {
  supplierId: string;
  itemId: string;
  currencyCode: string;
  minQuantity: string;
  unitPrice: string;
  validFrom: string;
  validTo: string | null;
}

const COLUMNS = [
  'id',
  'tenant_id',
  'supplier_id',
  'item_id',
  'currency_code',
  'min_quantity',
  'unit_price',
  sql<string>`valid_from::text`.as('valid_from'),
  sql<string | null>`valid_to::text`.as('valid_to'),
  'created_by',
  'created_at',
  'updated_at',
] as const;

export class SupplierPricesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** A supplier's or an item's prices: by supplier, item, break and date. */
  async list(query: { supplierId?: string; itemId?: string }): Promise<SupplierPrice[]> {
    let select = this.db
      .selectFrom('erp_supplier_prices')
      .select(COLUMNS)
      .where('tenant_id', '=', this.tenantId);
    if (query.supplierId !== undefined) {
      select = select.where('supplier_id', '=', query.supplierId);
    }
    if (query.itemId !== undefined) {
      select = select.where('item_id', '=', query.itemId);
    }
    return (
      await select
        .orderBy('supplier_id')
        .orderBy('item_id')
        .orderBy('min_quantity')
        .orderBy('valid_from', 'desc')
        .limit(2000)
        .execute()
    ).map(toPrice);
  }

  async find(priceId: string): Promise<SupplierPrice | undefined> {
    const row = await this.db
      .selectFrom('erp_supplier_prices')
      .select(COLUMNS)
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', priceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrice(row);
  }

  /**
   * Another price for the same supplier, item, currency and break whose days
   * overlap these: two prices would then be in force at once.
   */
  async overlapping(
    input: SupplierPriceInput,
    exceptId?: string,
  ): Promise<SupplierPrice | undefined> {
    let select = this.db
      .selectFrom('erp_supplier_prices')
      .select(COLUMNS)
      .where('tenant_id', '=', this.tenantId)
      .where('supplier_id', '=', input.supplierId)
      .where('item_id', '=', input.itemId)
      .where('currency_code', '=', input.currencyCode)
      .where(sql<boolean>`min_quantity = ${input.minQuantity}::numeric`)
      .where(
        sql<boolean>`daterange(valid_from, valid_to, '[]') && daterange(${input.validFrom}::date, ${input.validTo}::date, '[]')`,
      );
    if (exceptId !== undefined) {
      select = select.where('id', '<>', exceptId);
    }
    const row = await select.limit(1).executeTakeFirst();
    return row === undefined ? undefined : toPrice(row);
  }

  async create(input: SupplierPriceInput, createdBy: UserId | string): Promise<SupplierPrice> {
    const row = await this.db
      .insertInto('erp_supplier_prices')
      .values({
        tenant_id: this.tenantId,
        supplier_id: input.supplierId,
        item_id: input.itemId,
        currency_code: input.currencyCode,
        min_quantity: input.minQuantity,
        unit_price: input.unitPrice,
        valid_from: input.validFrom,
        valid_to: input.validTo,
        created_by: toUserId(createdBy),
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toPrice(row);
  }

  async update(
    priceId: string,
    input: Omit<SupplierPriceInput, 'supplierId' | 'itemId'>,
  ): Promise<SupplierPrice | undefined> {
    const row = await this.db
      .updateTable('erp_supplier_prices')
      .set({
        currency_code: input.currencyCode,
        min_quantity: input.minQuantity,
        unit_price: input.unitPrice,
        valid_from: input.validFrom,
        valid_to: input.validTo,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', priceId)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrice(row);
  }

  async remove(priceId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('erp_supplier_prices')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', priceId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /**
   * The price in force on a day for this quantity: of the supplier's prices
   * for the item in this currency valid that day, the one with the greatest
   * break not above the quantity. Undefined when none applies.
   */
  async priceFor(query: {
    supplierId: string;
    itemId: string;
    currencyCode: string;
    quantity: string;
    on: string;
  }): Promise<SupplierPrice | undefined> {
    const row = await this.db
      .selectFrom('erp_supplier_prices')
      .select(COLUMNS)
      .where('tenant_id', '=', this.tenantId)
      .where('supplier_id', '=', query.supplierId)
      .where('item_id', '=', query.itemId)
      .where('currency_code', '=', query.currencyCode)
      .where(sql<boolean>`min_quantity <= ${query.quantity}::numeric`)
      .where(sql<boolean>`valid_from <= ${query.on}::date`)
      .where(sql<boolean>`(valid_to is null or valid_to >= ${query.on}::date)`)
      .orderBy('min_quantity', 'desc')
      .orderBy('valid_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrice(row);
  }

  /**
   * The breaks in force on a day for items from one supplier, in any
   * currency, smallest first: what a reorder rounds up to.
   */
  async breaksOn(
    supplierId: string,
    itemIds: readonly string[],
    on: string,
  ): Promise<SupplierPrice[]> {
    if (itemIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_supplier_prices')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where('supplier_id', '=', supplierId)
        .where('item_id', 'in', [...new Set(itemIds)])
        .where(sql<boolean>`valid_from <= ${on}::date`)
        .where(sql<boolean>`(valid_to is null or valid_to >= ${on}::date)`)
        .orderBy('item_id')
        .orderBy('min_quantity')
        .execute()
    ).map(toPrice);
  }
}

function toPrice(
  row: Pick<
    Selectable<ErpSupplierPricesTable>,
    | 'id'
    | 'supplier_id'
    | 'item_id'
    | 'currency_code'
    | 'min_quantity'
    | 'unit_price'
    | 'created_by'
    | 'created_at'
    | 'updated_at'
  > & { valid_from: string; valid_to: string | null },
): SupplierPrice {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    itemId: row.item_id,
    currencyCode: row.currency_code,
    minQuantity: trimDecimal(row.min_quantity),
    unitPrice: trimDecimal(row.unit_price),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
