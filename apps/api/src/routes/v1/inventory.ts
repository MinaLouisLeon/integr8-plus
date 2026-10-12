import {
  holds,
  type Principal,
  ITEM_KINDS,
  itemKindSchema,
  LOCATION_KINDS,
  locationKindSchema,
  locationOwnershipSchema,
  quantitySchema,
  unitSchema,
  decimalAmountSchema,
  compareDecimals,
} from '@integr8/core';
import {
  type Item,
  type ItemCategory,
  type StockLocation,
  type TenantTransaction,
  withTenant,
  addDecimals,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit, requireAssignableMember, versionConflict } from './crm-shared.js';
import { booleanQuery, decodeNameCursor, encodeNameCursor, many } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * The catalogue and stock locations (CRM/ERP plan, phase E1).
 *
 * Every route needs the company's `inventory` module as well as the seat's
 * permission. Costs are shown only to seats that move stock (`inventory.move`):
 * engineers and viewers see what there is and where, not what it cost.
 */

export const TAGS = ['inventory'];
export const FEATURE = 'inventory' as const;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const itemSummarySchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  name: z.string(),
  kind: itemKindSchema,
  unit: unitSchema,
});

export const itemSchema = itemSummarySchema.extend({
  description: z.string().nullable(),
  categoryId: z.uuid().nullable(),
  barcode: z.string().nullable(),
  /** Decimal strings in the company currency; null to seats that may not see costs. */
  defaultUnitCost: z.string().nullable(),
  salePrice: z.string().nullable(),
  averageUnitCost: z.string().nullable(),
  /** Set once the `purchasing` module is in use (phase E2). */
  preferredSupplierId: z.uuid().nullable(),
  supplierPartNumber: z.string().nullable(),
  /** Days to build or to arrive; the preferred supplier's when null. */
  leadTimeDays: z.number().int().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export function itemSummary(item: Item): z.infer<typeof itemSummarySchema> {
  return { id: item.id, sku: item.sku, name: item.name, kind: item.kind, unit: item.unit };
}

export function itemBody(item: Item, seeCosts: boolean): z.infer<typeof itemSchema> {
  return {
    ...itemSummary(item),
    description: item.description,
    categoryId: item.categoryId,
    barcode: item.barcode,
    defaultUnitCost: seeCosts ? item.defaultUnitCost : null,
    salePrice: item.salePrice,
    averageUnitCost: seeCosts ? item.averageUnitCost : null,
    preferredSupplierId: item.preferredSupplierId,
    supplierPartNumber: item.supplierPartNumber,
    leadTimeDays: item.leadTimeDays,
    version: item.version,
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
    archivedAt: isoOrNull(item.archivedAt),
  };
}

export const locationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: locationKindSchema,
});

export const locationSchema = locationSummarySchema.extend({
  /** Whose stock it holds: ours, or (a site only) the customer's, never valued (ADR-0012). */
  ownership: locationOwnershipSchema,
  assignedTo: z.uuid().nullable(),
  site: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
});

export function locationSummary(location: StockLocation): z.infer<typeof locationSummarySchema> {
  return { id: location.id, name: location.name, kind: location.kind };
}

export async function locationBodies(
  tx: TenantTransaction,
  locations: readonly StockLocation[],
): Promise<z.infer<typeof locationSchema>[]> {
  const sites = new Map(
    (
      await Promise.all(
        [...new Set(locations.flatMap((row) => (row.siteId === null ? [] : [row.siteId])))].map(
          (id) => tx.sites.find(id),
        ),
      )
    ).flatMap((site) => (site === undefined ? [] : [[site.id, site] as const])),
  );
  return locations.map((location) => {
    const site = location.siteId === null ? undefined : sites.get(location.siteId);
    return {
      ...locationSummary(location),
      ownership: location.ownership,
      assignedTo: location.assignedTo,
      site: site === undefined ? null : { id: site.id, name: site.name },
      notes: location.notes,
      version: location.version,
      archivedAt: isoOrNull(location.archivedAt),
    };
  });
}

const categorySchema = z.object({ id: z.uuid(), name: z.string(), archived: z.boolean() });
const categoryBody = (category: ItemCategory) => ({
  id: category.id,
  name: category.name,
  archived: category.archivedAt !== null,
});

/** Seats that move stock see what it cost. */
export const seesCosts = (principal: Principal) => holds(principal, 'inventory.move');

/** Unique-index violations, said in words. */
function uniqueRefusal(error: unknown): never {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === '23505') {
    const known: Record<string, [string, string, string]> = {
      erp_items_sku_unique: ['sku_taken', 'body.sku', 'Another item already has this SKU.'],
      erp_items_barcode_unique: [
        'barcode_taken',
        'body.barcode',
        'Another item already has this barcode.',
      ],
      erp_item_categories_name_unique: [
        'category_name_taken',
        'body.name',
        'There is already a category with this name.',
      ],
      erp_stock_locations_name_unique: [
        'location_name_taken',
        'body.name',
        'There is already a location with this name.',
      ],
      erp_stock_locations_one_van_each: [
        'member_has_van',
        'body.assignedTo',
        'This person already has a van. Unassign it first.',
      ],
    };
    const match = constraint === undefined ? undefined : known[constraint];
    if (match !== undefined) {
      const [code409, field, message] = match;
      throw new ApiError(409, code409, message, [{ field, code: code409, message }]);
    }
  }
  throw error;
}

/** A supplier of this company, when one is named. */
async function requireSupplier(tx: TenantTransaction, supplierId: string | null | undefined) {
  if (
    typeof supplierId === 'string' &&
    (await tx.inventoryPurchasing.findSupplier(supplierId)) === undefined
  ) {
    throw new ApiError(404, 'supplier_not_found', 'This supplier does not exist.', [
      {
        field: 'body.preferredSupplierId',
        code: 'supplier_not_found',
        message: 'This supplier does not exist.',
      },
    ]);
  }
}

async function requireCategory(tx: TenantTransaction, categoryId: string | null | undefined) {
  if (
    typeof categoryId === 'string' &&
    (await tx.inventoryCatalogue.findCategory(categoryId)) === undefined
  ) {
    throw new ApiError(404, 'category_not_found', 'This category does not exist.', [
      {
        field: 'body.categoryId',
        code: 'category_not_found',
        message: 'This category does not exist.',
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const listCategoriesRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/categories',
  operationId: 'listItemCategories',
  summary: 'Item categories',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({ includeArchived: booleanQuery }),
  body: noSchema,
  responses: {
    200: { description: 'Alphabetical.', schema: z.object({ items: z.array(categorySchema) }) },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, (tx) =>
      tx.inventoryCatalogue.listCategories({ includeArchived: query.includeArchived === 'true' }),
    );
    return { status: 200, body: { items: items.map(categoryBody) } };
  },
});

export const createCategoryRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/categories',
  operationId: 'createItemCategory',
  summary: 'Add an item category',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({ name: z.string().trim().min(1).max(100) }),
  responses: {
    201: { description: 'The category.', schema: categorySchema },
    409: { description: 'The name is taken (`category_name_taken`).' },
  },
  handler: async ({ body }, context) => {
    const category = await withTenant(context.principal.tenantId, async (tx) => {
      const created = await tx.inventoryCatalogue.createCategory(body.name).catch(uniqueRefusal);
      await audit(tx, context, 'inventory_category.created', 'inventory_category', created.id, {
        name: created.name,
      });
      return created;
    });
    return { status: 201, body: categoryBody(category) };
  },
});

export const updateCategoryRoute = defineRoute({
  method: 'patch',
  path: '/v1/inventory/categories/:categoryId',
  operationId: 'updateItemCategory',
  summary: 'Rename or archive an item category',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: z.object({ categoryId: z.uuid() }),
  query: noSchema,
  body: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  responses: {
    200: { description: 'The category.', schema: categorySchema },
    404: { description: 'No such category.' },
    409: { description: 'The name is taken (`category_name_taken`).' },
  },
  handler: async ({ params, body }, context) => {
    const category = await withTenant(context.principal.tenantId, async (tx) => {
      const updated = await tx.inventoryCatalogue
        .updateCategory(params.categoryId, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        })
        .catch(uniqueRefusal);
      if (updated === undefined) {
        throw notFound('This category does not exist.');
      }
      await audit(tx, context, 'inventory_category.updated', 'inventory_category', updated.id, {
        fields: Object.keys(body),
      });
      return updated;
    });
    return { status: 200, body: categoryBody(category) };
  },
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const itemFields = {
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  kind: itemKindSchema.optional(),
  categoryId: z.uuid().nullable().optional(),
  unit: unitSchema.optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  defaultUnitCost: decimalAmountSchema.nullable().optional(),
  salePrice: decimalAmountSchema.nullable().optional(),
  preferredSupplierId: z.uuid().nullable().optional(),
  supplierPartNumber: z.string().trim().max(64).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
};

/** What the request carries, without what it left out. */
function itemInput(body: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    Object.keys(itemFields).flatMap((key) => (body[key] === undefined ? [] : [[key, body[key]]])),
  );
}

export const listItemsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/items',
  operationId: 'listItems',
  summary: 'Find items in the catalogue',
  description:
    'Alphabetical, a page at a time, with how much the company holds of each, everywhere together. `q` matches words or their beginnings in the SKU, name, barcode or description.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    kind: many(itemKindSchema, ITEM_KINDS.length),
    categoryId: z.uuid().optional(),
    includeArchived: booleanQuery,
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of items.',
      schema: z.object({
        items: z.array(itemSchema.extend({ onHand: z.string() })),
        nextCursor: z.string().nullable(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeNameCursor(query.cursor);
    const page = await withTenant(context.principal.tenantId, (tx) =>
      tx.inventoryCatalogue.listItems({
        ...(query.q === undefined ? {} : { text: query.q }),
        kinds: query.kind,
        ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
        includeArchived: query.includeArchived === 'true',
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      }),
    );
    const costs = seesCosts(context.principal);
    return {
      status: 200,
      body: {
        items: page.items.map((item) => ({ ...itemBody(item, costs), onHand: item.onHand })),
        nextCursor: encodeNameCursor(page.next),
      },
    };
  },
});

export const createItemRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/items',
  operationId: 'createItem',
  summary: 'Add an item to the catalogue',
  description: 'Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object(itemFields),
  responses: {
    201: { description: 'The item.', schema: itemSchema },
    404: {
      description: 'No such category (`category_not_found`) or supplier (`supplier_not_found`).',
    },
    409: { description: 'The SKU (`sku_taken`) or barcode (`barcode_taken`) is taken.' },
  },
  handler: async ({ body }, context) => {
    const item = await withTenant(context.principal.tenantId, async (tx) => {
      await requireCategory(tx, body.categoryId);
      await requireSupplier(tx, body.preferredSupplierId);
      const created = await tx.inventoryCatalogue
        .createItem(
          { ...itemInput(body), sku: body.sku, name: body.name },
          context.principal.userId,
        )
        .catch(uniqueRefusal);
      await audit(tx, context, 'inventory_item.created', 'inventory_item', created.id, {
        sku: created.sku,
        kind: created.kind,
      });
      return created;
    });
    return { status: 201, body: itemBody(item, seesCosts(context.principal)) };
  },
});

/** What is reserved where, keyed `itemId:locationId` (ADR-0006). */
export async function reservedAt(
  tx: TenantTransaction,
  query: { itemId?: string; locationId?: string },
): Promise<Map<string, string>> {
  const rows = await tx.salesOrders.reservations(query);
  return new Map(rows.map((row) => [`${row.itemId}:${row.locationId}`, row.reserved]));
}

/** Reserved and available from on-hand and what orders hold; available never below zero. */
export function availability(
  onHand: string,
  reserved = '0',
): { reserved: string; available: string } {
  const available = addDecimals(onHand, `-${reserved}`);
  return { reserved, available: compareDecimals(available, '0') < 0 ? '0' : available };
}

const stockLineSchema = z.object({
  location: locationSummarySchema,
  onHand: z.string(),
  /** Promised to confirmed sales orders here (ADR-0006). */
  reserved: z.string(),
  /** On hand less reserved, never below zero. */
  available: z.string(),
  /** The reorder level here, if one is set. */
  minimum: z.string().nullable(),
});

export const itemDetailSchema = z.object({
  item: itemSchema,
  /** Every location that holds it or has a reorder level for it. */
  stock: z.array(stockLineSchema),
  onHand: z.string(),
  reserved: z.string(),
  available: z.string(),
  can: z.object({ manage: z.boolean(), move: z.boolean() }),
});

export const getItemRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/items/:itemId',
  operationId: 'getItem',
  summary: 'An item, with how much of it is where',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: z.object({ itemId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The item.', schema: itemDetailSchema },
    404: { description: 'No such item.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const item = await tx.inventoryCatalogue.findItem(params.itemId);
      if (item === undefined) {
        throw notFound('This item does not exist.');
      }
      return itemDetailBody(tx, principal, item);
    });
    return { status: 200, body };
  },
});

/** The item with how much of it is where: held, reserved for orders, and available. */
export async function itemDetailBody(
  tx: TenantTransaction,
  principal: Principal,
  item: Item,
): Promise<z.infer<typeof itemDetailSchema>> {
  const balances = await tx.inventoryStock.balances({ itemId: item.id });
  const [places, reserved, total] = await Promise.all([
    tx.inventoryStock.findLocations(balances.map((row) => row.locationId)),
    reservedAt(tx, { itemId: item.id }),
    sumDecimals(
      tx,
      balances.map((row) => row.onHand),
    ),
  ]);
  const locations = new Map(places.map((location) => [location.id, location]));
  const totalReserved = await sumDecimals(tx, [...reserved.values()]);
  return {
    item: itemBody(item, seesCosts(principal)),
    stock: balances.flatMap((row) => {
      const location = locations.get(row.locationId);
      return location === undefined
        ? []
        : [
            {
              location: locationSummary(location),
              onHand: row.onHand,
              ...availability(row.onHand, reserved.get(`${row.itemId}:${row.locationId}`)),
              minimum: row.minimum,
            },
          ];
    }),
    onHand: total,
    ...availability(total, totalReserved),
    can: {
      manage: holds(principal, 'inventory.manage'),
      move: holds(principal, 'inventory.move'),
    },
  };
}

/** Adds decimal strings exactly, in the database. */
export async function sumDecimals(
  tx: TenantTransaction,
  values: readonly string[],
): Promise<string> {
  return tx.inventoryStock.sum(values);
}

export const updateItemRoute = defineRoute({
  method: 'patch',
  path: '/v1/inventory/items/:itemId',
  operationId: 'updateItem',
  summary: 'Change or archive an item',
  description:
    'Send `expectedVersion` as read. An item that holds stock stays a stock item (`item_has_stock`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: z.object({ itemId: z.uuid() }),
  query: noSchema,
  body: z
    .object({
      ...itemFields,
      sku: itemFields.sku.optional(),
      name: itemFields.name.optional(),
      expectedVersion: z.number().int().positive(),
      archived: z.boolean().optional(),
    })
    .strict(),
  responses: {
    200: { description: 'The item as it is now.', schema: itemSchema },
    404: { description: 'No such item, category or supplier.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`), SKU or barcode taken, or it holds stock (`item_has_stock`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const item = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.inventoryCatalogue.findItem(params.itemId);
      if (current === undefined) {
        throw notFound('This item does not exist.');
      }
      await requireCategory(tx, body.categoryId);
      await requireSupplier(tx, body.preferredSupplierId);
      if (body.kind !== undefined && body.kind !== 'stock_item' && current.kind === 'stock_item') {
        const held = await tx.inventoryStock.balances({ itemId: current.id });
        if (held.some((row) => row.onHand !== '0')) {
          throw conflict(
            'item_has_stock',
            'This item holds stock. Move or count it to zero before it stops being a stock item.',
          );
        }
      }
      const result = await tx.inventoryCatalogue
        .updateItem(current.id, body.expectedVersion, {
          ...itemInput(body),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        })
        .catch(uniqueRefusal);
      if (result === 'not_found') {
        throw notFound('This item does not exist.');
      }
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      await audit(tx, context, 'inventory_item.updated', 'inventory_item', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
        version: result.version,
      });
      return result;
    });
    return { status: 200, body: itemBody(item, seesCosts(context.principal)) };
  },
});

export const setReorderLevelsRoute = defineRoute({
  method: 'put',
  path: '/v1/inventory/items/:itemId/reorder-levels',
  operationId: 'setReorderLevels',
  summary: 'Set where an item should be reordered, and below what',
  description: 'Replaces the item’s reorder levels. Stock items only.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: z.object({ itemId: z.uuid() }),
  query: noSchema,
  body: z.object({
    levels: z
      .array(z.object({ locationId: z.uuid(), minimum: quantitySchema }))
      .max(200)
      .refine(
        (levels) => new Set(levels.map((level) => level.locationId)).size === levels.length,
        'One level per location',
      ),
  }),
  responses: {
    200: { description: 'The item, with its stock and levels.', schema: itemDetailSchema },
    404: { description: 'No such item or location.' },
    422: { description: 'Not a stock item (`not_stock_item`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const item = await tx.inventoryCatalogue.findItem(params.itemId);
      if (item === undefined) {
        throw notFound('This item does not exist.');
      }
      if (item.kind !== 'stock_item') {
        throw unprocessable('not_stock_item', 'Only stock items have reorder levels.');
      }
      const found = await tx.inventoryStock.findLocations(
        body.levels.map((level) => level.locationId),
      );
      if (found.length !== body.levels.length) {
        throw new ApiError(404, 'location_not_found', 'A location does not exist.');
      }
      await tx.inventoryStock.setReorderLevels(item.id, body.levels);
      await audit(tx, context, 'inventory_item.reorder_levels_set', 'inventory_item', item.id, {
        levels: body.levels.length,
      });
      return itemDetailBody(tx, principal, item);
    });
    return { status: 200, body: detail };
  },
});

export const lookupItemRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/lookup',
  operationId: 'lookupItemByBarcode',
  summary: 'The item with this barcode',
  description: 'For scanning.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({ barcode: z.string().trim().min(1).max(64) }),
  body: noSchema,
  responses: {
    200: { description: 'The item.', schema: itemSchema },
    404: { description: 'No item has this barcode.' },
  },
  handler: async ({ query }, context) => {
    const item = await withTenant(context.principal.tenantId, (tx) =>
      tx.inventoryCatalogue.findItemByBarcode(query.barcode),
    );
    if (item === undefined) {
      throw notFound('No item has this barcode.');
    }
    return { status: 200, body: itemBody(item, seesCosts(context.principal)) };
  },
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const listLocationsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/locations',
  operationId: 'listStockLocations',
  summary: 'Warehouses, vans and site locations',
  description: 'Warehouses first, then vans, then sites; alphabetical within each.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    kind: many(locationKindSchema, LOCATION_KINDS.length),
    includeArchived: booleanQuery,
  }),
  body: noSchema,
  responses: {
    200: { description: 'Locations.', schema: z.object({ items: z.array(locationSchema) }) },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) =>
      locationBodies(
        tx,
        await tx.inventoryStock.listLocations({
          kinds: query.kind,
          includeArchived: query.includeArchived === 'true',
        }),
      ),
    );
    return { status: 200, body: { items } };
  },
});

export const createLocationRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/locations',
  operationId: 'createStockLocation',
  summary: 'Add a warehouse, a van or a site location',
  description:
    'A van may be assigned to one active member, who has at most one van. A site location names one of the company’s customer sites, and says whose stock it holds: `ours` (counted and valued) or `customer` (a record of what they hold, never valued; moving our stock there issues it from ours).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z
    .object({
      name: z.string().trim().min(1).max(100),
      kind: locationKindSchema,
      assignedTo: z.uuid().nullable().optional(),
      siteId: z.uuid().optional(),
      ownership: locationOwnershipSchema.default('ours'),
      notes: z.string().max(2000).nullable().optional(),
    })
    .superRefine((body, issues) => {
      if (body.kind !== 'site' && body.ownership === 'customer') {
        issues.addIssue({
          code: 'custom',
          path: ['ownership'],
          message: 'Only a site location holds the customer’s stock',
        });
      }
      if (body.kind !== 'van' && typeof body.assignedTo === 'string') {
        issues.addIssue({
          code: 'custom',
          path: ['assignedTo'],
          message: 'Only a van is assigned to somebody',
        });
      }
      if ((body.kind === 'site') !== (body.siteId !== undefined)) {
        issues.addIssue({
          code: 'custom',
          path: ['siteId'],
          message: 'A site location names a site, and only it does',
        });
      }
    }),
  responses: {
    201: { description: 'The location.', schema: locationSchema },
    404: { description: 'No such site (`site_not_found`).' },
    409: {
      description:
        'Name taken (`location_name_taken`), or the member already has a van (`member_has_van`).',
    },
    422: {
      description: 'Invalid, or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ body }, context) => {
    const location = await withTenant(context.principal.tenantId, async (tx) => {
      if (typeof body.assignedTo === 'string') {
        await requireAssignableMember(tx, body.assignedTo);
      }
      if (body.siteId !== undefined && (await tx.sites.find(body.siteId)) === undefined) {
        throw new ApiError(404, 'site_not_found', 'This site does not exist.');
      }
      const created = await tx.inventoryStock
        .createLocation({
          name: body.name,
          kind: body.kind,
          assignedTo: body.assignedTo ?? null,
          siteId: body.siteId ?? null,
          ownership: body.ownership,
          notes: body.notes ?? null,
        })
        .catch(uniqueRefusal);
      await audit(tx, context, 'inventory_location.created', 'inventory_location', created.id, {
        kind: created.kind,
        ...(created.assignedTo === null ? {} : { assignedTo: created.assignedTo }),
      });
      return (await locationBodies(tx, [created]))[0]!;
    });
    return { status: 201, body: location };
  },
});

export const locationDetailSchema = z.object({
  location: locationSchema,
  /** Every item it holds or has a reorder level for. */
  stock: z.array(
    z.object({
      item: itemSummarySchema,
      onHand: z.string(),
      reserved: z.string(),
      available: z.string(),
      minimum: z.string().nullable(),
    }),
  ),
  can: z.object({ manage: z.boolean(), move: z.boolean() }),
});

export const getLocationRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/locations/:locationId',
  operationId: 'getStockLocation',
  summary: 'A location and what it holds',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: z.object({ locationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The location.', schema: locationDetailSchema },
    404: { description: 'No such location.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const location = await tx.inventoryStock.findLocation(params.locationId);
      if (location === undefined) {
        throw notFound('This location does not exist.');
      }
      const balances = await tx.inventoryStock.balances({ locationId: location.id });
      const [found, reserved] = await Promise.all([
        tx.inventoryCatalogue.findItems(balances.map((row) => row.itemId)),
        reservedAt(tx, { locationId: location.id }),
      ]);
      const items = new Map(found.map((item) => [item.id, item]));
      return {
        location: (await locationBodies(tx, [location]))[0]!,
        stock: balances
          .flatMap((row) => {
            const item = items.get(row.itemId);
            return item === undefined
              ? []
              : [
                  {
                    item: itemSummary(item),
                    onHand: row.onHand,
                    ...availability(row.onHand, reserved.get(`${row.itemId}:${row.locationId}`)),
                    minimum: row.minimum,
                  },
                ];
          })
          .sort((a, b) => a.item.name.localeCompare(b.item.name)),
        can: {
          manage: holds(principal, 'inventory.manage'),
          move: holds(principal, 'inventory.move'),
        },
      };
    });
    return { status: 200, body };
  },
});

export const updateLocationRoute = defineRoute({
  method: 'patch',
  path: '/v1/inventory/locations/:locationId',
  operationId: 'updateStockLocation',
  summary: 'Rename a location, assign a van, or archive an empty location',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: z.object({ locationId: z.uuid() }),
  query: noSchema,
  body: z
    .object({
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(100).optional(),
      /** Vans only: the member who drives it, or null for nobody. */
      assignedTo: z.uuid().nullable().optional(),
      /** Site locations only, and only before anything has moved there. */
      ownership: locationOwnershipSchema.optional(),
      notes: z.string().max(2000).nullable().optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  responses: {
    200: { description: 'The location as it is now.', schema: locationSchema },
    404: { description: 'No such location.' },
    409: {
      description:
        'Changed by somebody else (`version_conflict`), name taken, the member already has a van (`member_has_van`), it still holds stock (`location_not_empty`), or stock has moved there so whose it is is fixed (`ownership_fixed`).',
    },
    422: {
      description:
        'Only vans are assigned (`not_a_van`), only a site holds the customer’s stock (`not_a_site`), or the assignee is not an active member.',
    },
  },
  handler: async ({ params, body }, context) => {
    const location = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.inventoryStock.findLocation(params.locationId);
      if (current === undefined) {
        throw notFound('This location does not exist.');
      }
      if (body.assignedTo !== undefined && current.kind !== 'van') {
        throw unprocessable('not_a_van', 'Only a van is assigned to somebody.');
      }
      if (typeof body.assignedTo === 'string') {
        await requireAssignableMember(tx, body.assignedTo);
      }
      if (body.ownership !== undefined && body.ownership !== current.ownership) {
        if (current.kind !== 'site') {
          throw unprocessable('not_a_site', 'Only a site location holds the customer’s stock.');
        }
        if (await tx.inventoryStock.hasMovements(current.id)) {
          throw conflict(
            'ownership_fixed',
            'Stock has moved at this location, so whose stock it holds can no longer change.',
          );
        }
      }
      if (body.archived === true) {
        const held = await tx.inventoryStock.balances({ locationId: current.id });
        if (held.some((row) => row.onHand !== '0')) {
          throw conflict(
            'location_not_empty',
            'This location still holds stock. Move it out before archiving the location.',
          );
        }
      }
      const result = await tx.inventoryStock
        .updateLocation(current.id, body.expectedVersion, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.assignedTo === undefined ? {} : { assignedTo: body.assignedTo }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          ...(body.ownership === undefined ? {} : { ownership: body.ownership }),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        })
        .catch(uniqueRefusal);
      if (result === 'not_found') {
        throw notFound('This location does not exist.');
      }
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      await audit(tx, context, 'inventory_location.updated', 'inventory_location', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
      });
      if (body.assignedTo !== undefined && body.assignedTo !== current.assignedTo) {
        await audit(
          tx,
          context,
          'inventory_location.van_assigned',
          'inventory_location',
          result.id,
          {
            from: current.assignedTo,
            to: body.assignedTo,
          },
        );
      }
      return (await locationBodies(tx, [result]))[0]!;
    });
    return { status: 200, body: location };
  },
});

export const catalogueRoutes = [
  listCategoriesRoute,
  createCategoryRoute,
  updateCategoryRoute,
  listItemsRoute,
  createItemRoute,
  getItemRoute,
  updateItemRoute,
  setReorderLevelsRoute,
  lookupItemRoute,
  listLocationsRoute,
  createLocationRoute,
  getLocationRoute,
  updateLocationRoute,
];
