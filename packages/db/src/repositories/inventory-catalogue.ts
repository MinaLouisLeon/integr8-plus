import {
  type ItemKind,
  type TenantId,
  type Unit,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpItemCategoriesTable, ErpItemsTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * The catalogue (CRM/ERP plan, phase E1): what a company stocks, buys, uses
 * and sells, and the categories it files them under. Nothing is deleted:
 * items and categories are archived, because the ledger and every document
 * that used them keep pointing at them.
 */

export interface ItemCategory {
  id: string;
  name: string;
  archivedAt: Date | null;
}

export interface Item {
  id: string;
  tenantId: TenantId;
  sku: string;
  name: string;
  description: string | null;
  kind: ItemKind;
  categoryId: string | null;
  unit: Unit;
  barcode: string | null;
  /** Decimal strings without trailing zeros; never JavaScript numbers. */
  defaultUnitCost: string | null;
  salePrice: string | null;
  averageUnitCost: string;
  preferredSupplierId: string | null;
  supplierPartNumber: string | null;
  /** Days to build or to arrive; the preferred supplier's when null (0039). */
  leadTimeDays: number | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** An item with how much of it the company holds, everywhere together. */
export interface ItemWithStock extends Item {
  onHand: string;
}

export interface ItemInput {
  sku: string;
  name: string;
  description?: string | null;
  kind?: ItemKind;
  categoryId?: string | null;
  unit?: Unit;
  barcode?: string | null;
  defaultUnitCost?: string | null;
  salePrice?: string | null;
  preferredSupplierId?: string | null;
  supplierPartNumber?: string | null;
  leadTimeDays?: number | null;
}

export interface ItemQuery {
  /** Words from the SKU, name, barcode or description. Prefixes match. */
  text?: string;
  kinds?: readonly ItemKind[];
  categoryId?: string;
  includeArchived?: boolean;
  /** The last row of the previous page. */
  after?: { name: string; id: string };
  limit?: number;
}

export interface ItemPage {
  items: ItemWithStock[];
  next: { name: string; id: string } | undefined;
}

export type ItemRefusal = 'not_found' | 'version_conflict';

export class InventoryCatalogueRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  async listCategories(options: { includeArchived?: boolean } = {}): Promise<ItemCategory[]> {
    let select = this.db
      .selectFrom('erp_item_categories')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (options.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    return (await select.orderBy(sql`lower(name)`).execute()).map(toCategory);
  }

  async findCategory(categoryId: string): Promise<ItemCategory | undefined> {
    const row = await this.db
      .selectFrom('erp_item_categories')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', categoryId)
      .executeTakeFirst();
    return row === undefined ? undefined : toCategory(row);
  }

  async createCategory(name: string): Promise<ItemCategory> {
    const row = await this.db
      .insertInto('erp_item_categories')
      .values({ tenant_id: this.tenantId, name: name.trim() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCategory(row);
  }

  async updateCategory(
    categoryId: string,
    input: { name?: string; archived?: boolean },
  ): Promise<ItemCategory | undefined> {
    const row = await this.db
      .updateTable('erp_item_categories')
      .set({
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.archived === undefined
          ? {}
          : { archived_at: input.archived ? sql<Date>`coalesce(archived_at, now())` : null }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', categoryId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toCategory(row);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async createItem(input: ItemInput, createdBy: UserId | string): Promise<Item> {
    const row = await this.db
      .insertInto('erp_items')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...itemColumns(input),
        sku: input.sku.trim(),
        name: input.name.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toItem(row);
  }

  async findItem(itemId: string): Promise<Item | undefined> {
    const row = await this.db
      .selectFrom('erp_items')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', itemId)
      .executeTakeFirst();
    return row === undefined ? undefined : toItem(row);
  }

  async findItems(itemIds: readonly string[]): Promise<Item[]> {
    if (itemIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_items')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(itemIds)])
        .execute()
    ).map(toItem);
  }

  /** The item with this barcode, for scanning. */
  async findItemByBarcode(barcode: string): Promise<Item | undefined> {
    const row = await this.db
      .selectFrom('erp_items')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('barcode', '=', barcode.trim())
      .executeTakeFirst();
    return row === undefined ? undefined : toItem(row);
  }

  /** Changes an item, provided nobody has changed it since `expectedVersion`. */
  async updateItem(
    itemId: string,
    expectedVersion: number,
    input: Partial<ItemInput> & { archived?: boolean },
  ): Promise<Item | ItemRefusal> {
    const row = await this.db
      .updateTable('erp_items')
      .set({
        ...itemColumns(input),
        ...(input.archived === undefined
          ? {}
          : { archived_at: input.archived ? sql<Date>`coalesce(archived_at, now())` : null }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', itemId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return toItem(row);
    }
    return (await this.findItem(itemId)) === undefined ? 'not_found' : 'version_conflict';
  }

  /** Alphabetical, a page at a time, with each item's stock everywhere together. */
  async listItems(query: ItemQuery = {}): Promise<ItemPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let select = this.db
      .selectFrom('erp_items')
      .selectAll('erp_items')
      .select(
        sql<string>`coalesce((select sum(b.on_hand) from erp_stock_balances b where b.tenant_id = erp_items.tenant_id and b.item_id = erp_items.id), 0)::text`.as(
          'on_hand',
        ),
      )
      .where('erp_items.tenant_id', '=', this.tenantId);

    const words = query.text === undefined ? undefined : prefixQuery(query.text);
    if (words !== undefined) {
      select = select.where(sql<boolean>`search @@ to_tsquery('simple', ${words})`);
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      select = select.where('kind', 'in', [...query.kinds]);
    }
    if (query.categoryId !== undefined) {
      select = select.where('category_id', '=', query.categoryId);
    }
    if (query.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
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
    const items = rows
      .slice(0, limit)
      .map((row) => ({ ...toItem(row), onHand: trimDecimal(row.on_hand) }));
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined ? { name: last.name, id: last.id } : undefined,
    };
  }
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function itemColumns(input: Partial<ItemInput>) {
  return {
    ...(input.sku === undefined ? {} : { sku: input.sku.trim() }),
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.description === undefined ? {} : { description: blankToNull(input.description) }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.categoryId === undefined ? {} : { category_id: input.categoryId }),
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    ...(input.barcode === undefined ? {} : { barcode: blankToNull(input.barcode) }),
    ...(input.defaultUnitCost === undefined
      ? {}
      : { default_unit_cost: blankToNull(input.defaultUnitCost) }),
    ...(input.salePrice === undefined ? {} : { sale_price: blankToNull(input.salePrice) }),
    ...(input.preferredSupplierId === undefined
      ? {}
      : { preferred_supplier_id: input.preferredSupplierId }),
    ...(input.supplierPartNumber === undefined
      ? {}
      : { supplier_part_number: blankToNull(input.supplierPartNumber) }),
    ...(input.leadTimeDays === undefined ? {} : { lead_time_days: input.leadTimeDays }),
  };
}

function toCategory(row: Selectable<ErpItemCategoriesTable>): ItemCategory {
  return { id: row.id, name: row.name, archivedAt: row.archived_at };
}

export function toItem(row: Omit<Selectable<ErpItemsTable>, 'search'>): Item {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    sku: row.sku,
    name: row.name,
    description: row.description,
    kind: row.kind,
    categoryId: row.category_id,
    unit: row.unit,
    barcode: row.barcode,
    defaultUnitCost: row.default_unit_cost === null ? null : trimDecimal(row.default_unit_cost),
    salePrice: row.sale_price === null ? null : trimDecimal(row.sale_price),
    averageUnitCost: trimDecimal(row.average_unit_cost),
    preferredSupplierId: row.preferred_supplier_id,
    supplierPartNumber: row.supplier_part_number,
    leadTimeDays: row.lead_time_days,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}
