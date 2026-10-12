import {
  ASSEMBLY_ORDER_STATUSES,
  assemblyDirectionSchema,
  assemblyOrderStatusSchema,
  fromUnits,
  toUnits,
  componentNeeds,
  decimalAmountSchema,
  disassemblyUnitCosts,
  formatAssemblyReference,
  holds,
  multiplyDecimal,
  parseAssemblyReference,
  positiveQuantitySchema,
  type Principal,
  rolledUpUnitCost,
  wouldContainItself,
} from '@integr8/core';
import {
  type AssemblyOrder,
  type Bom,
  type Item,
  type MovementInput,
  type StockLocation,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  crmAudit as audit,
  decodeDateCursor,
  encodeDateCursor,
  versionConflict,
} from './crm-shared.js';
import {
  availability,
  itemSummary,
  itemSummarySchema,
  locationSummary,
  locationSummarySchema,
  reservedAt,
  seesCosts,
} from './inventory.js';
import { requireLocation, requireStockItem, stockRefusal } from './inventory-stock.js';
import { type People, peopleOf, personBody, personSchema } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Bills of materials, assembly and disassembly orders (seventh round;
 * ADR-0011). Owners, admins and inventory managers keep them; viewers read.
 *
 * A bill lists a stock item's components with a quantity per unit, and a
 * labour and overhead cost per unit. Saving one makes a new version; an
 * order keeps the version it was drafted with. Completing an assembly takes
 * the components out of its location at their average cost and brings the
 * item in at their cost plus labour and overhead, which joins the item's
 * average cost; a disassembly does the reverse, sharing the item's cost among
 * the components in proportion to theirs. Neither ever takes stock below
 * what is there and not promised to sales orders.
 */

export const TAGS = ['manufacturing'];
export const FEATURE = 'manufacturing' as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const componentSchema = z.object({
  item: itemSummarySchema,
  quantity: z.string(),
  /** Its unit cost now; null to seats that may not see costs. */
  unitCost: z.string().nullable(),
});

export const bomSchema = z.object({
  id: z.uuid(),
  item: itemSummarySchema,
  version: z.number().int(),
  labourCost: z.string().nullable(),
  overheadCost: z.string().nullable(),
  note: z.string().nullable(),
  components: z.array(componentSchema),
  /** One unit's cost if built now: its parts, labour and overhead. Null to seats that may not see costs. */
  unitCost: z.string().nullable(),
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
  superseded: z.boolean(),
});

const needSchema = z.object({
  item: itemSummarySchema,
  /** What the order takes out of the location. */
  quantity: z.string(),
  onHand: z.string(),
  reserved: z.string(),
  available: z.string(),
  short: z.string(),
});

export const assemblyOrderSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  direction: assemblyDirectionSchema,
  item: itemSummarySchema,
  bom: z.object({ id: z.uuid(), version: z.number().int(), current: z.boolean() }),
  location: locationSummarySchema,
  quantity: z.string(),
  status: assemblyOrderStatusSchema,
  plannedFor: z.iso.date().nullable(),
  planId: z.uuid().nullable(),
  note: z.string().nullable(),
  unitCost: z.string().nullable(),
  labourCost: z.string().nullable(),
  overheadCost: z.string().nullable(),
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
  completedBy: personSchema.nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledBy: personSchema.nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  version: z.number().int(),
});

const orderDetailSchema = assemblyOrderSchema.extend({
  /** For a draft: what completing it takes out, against what is there. */
  needs: z.array(needSchema),
  /** What completing it brings in. */
  outputs: z.array(z.object({ item: itemSummarySchema, quantity: z.string() })),
  can: z.object({ edit: z.boolean(), complete: z.boolean(), cancel: z.boolean() }),
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** How much more is needed than is available; '0' when there is enough. */
function shortBy(needed: string, available: string): string {
  const gap = toUnits(needed) - toUnits(available);
  return gap > 0n ? fromUnits(gap) : '0';
}

/** What a unit costs to hold now: average cost for stock, the default cost otherwise. */
const currentCost = (item: Item) =>
  item.kind === 'stock_item' ? item.averageUnitCost : (item.defaultUnitCost ?? '0');

async function itemsById(tx: TenantTransaction, ids: readonly string[]) {
  const items = await tx.inventoryCatalogue.findItems([...new Set(ids)]);
  return new Map(items.map((item) => [item.id, item]));
}

async function bomBody(
  tx: TenantTransaction,
  principal: Principal,
  bom: Bom,
  people?: People,
): Promise<z.infer<typeof bomSchema>> {
  const costs = seesCosts(principal);
  const items = await itemsById(tx, [bom.itemId, ...bom.components.map((c) => c.itemId)]);
  const unitCosts = new Map(
    bom.components.map((component) => {
      const item = items.get(component.itemId);
      return [component.itemId, item === undefined ? '0' : currentCost(item)];
    }),
  );
  return {
    id: bom.id,
    item: itemSummary(items.get(bom.itemId)!),
    version: bom.version,
    labourCost: costs ? bom.labourCost : null,
    overheadCost: costs ? bom.overheadCost : null,
    note: bom.note,
    components: bom.components.map((component) => ({
      item: itemSummary(items.get(component.itemId)!),
      quantity: component.quantity,
      unitCost: costs ? (unitCosts.get(component.itemId) ?? '0') : null,
    })),
    unitCost: costs
      ? rolledUpUnitCost(bom.components, unitCosts, bom.labourCost, bom.overheadCost)
      : null,
    createdBy: personBody(bom.createdBy, people ?? (await peopleOf(tx))),
    createdAt: iso(bom.createdAt),
    superseded: bom.supersededAt !== null,
  };
}

async function orderBody(
  tx: TenantTransaction,
  principal: Principal,
  order: AssemblyOrder,
  context: { people: People; items: Map<string, Item>; locations: Map<string, StockLocation> },
): Promise<z.infer<typeof assemblyOrderSchema>> {
  const costs = seesCosts(principal);
  const bom = await tx.manufacturing.bom(order.bomId);
  const person = (id: string | null) => (id === null ? null : personBody(id, context.people));
  return {
    id: order.id,
    reference: formatAssemblyReference(order.reference),
    direction: order.direction,
    item: itemSummary(context.items.get(order.itemId)!),
    bom: { id: order.bomId, version: bom?.version ?? 0, current: bom?.supersededAt === null },
    location: locationSummary(context.locations.get(order.locationId)!),
    quantity: order.quantity,
    status: order.status,
    plannedFor: order.plannedFor,
    planId: order.planId,
    note: order.note,
    unitCost: costs ? order.unitCost : null,
    labourCost: costs ? order.labourCost : null,
    overheadCost: costs ? order.overheadCost : null,
    createdBy: personBody(order.createdBy, context.people),
    createdAt: iso(order.createdAt),
    completedBy: person(order.completedBy),
    completedAt: isoOrNull(order.completedAt),
    cancelledBy: person(order.cancelledBy),
    cancelledAt: isoOrNull(order.cancelledAt),
    version: order.version,
  };
}

async function orderContext(tx: TenantTransaction, orders: readonly AssemblyOrder[]) {
  const [people, items, locations] = await Promise.all([
    peopleOf(tx),
    itemsById(
      tx,
      orders.map((order) => order.itemId),
    ),
    tx.inventoryStock.findLocations([...new Set(orders.map((order) => order.locationId))]),
  ]);
  return {
    people,
    items,
    locations: new Map(locations.map((location) => [location.id, location])),
  };
}

/** What completing an order moves: out of stock, and into it. */
async function movementsOf(tx: TenantTransaction, order: AssemblyOrder, bom: Bom) {
  const items = await itemsById(tx, [order.itemId, ...bom.components.map((c) => c.itemId)]);
  const stockComponents = bom.components.filter(
    (component) => items.get(component.itemId)?.kind === 'stock_item',
  );
  const componentQuantities = componentNeeds(stockComponents, order.quantity);
  if (order.direction === 'assemble') {
    return {
      items,
      out: componentQuantities,
      in: [{ itemId: order.itemId, quantity: order.quantity }],
    };
  }
  return {
    items,
    out: [{ itemId: order.itemId, quantity: order.quantity }],
    in: componentQuantities,
  };
}

async function orderDetail(
  tx: TenantTransaction,
  principal: Principal,
  order: AssemblyOrder,
): Promise<z.infer<typeof orderDetailSchema>> {
  const bom = await tx.manufacturing.bom(order.bomId);
  if (bom === undefined) {
    throw notFound('No such bill of materials.');
  }
  const context = await orderContext(tx, [order]);
  const moves = await movementsOf(tx, order, bom);
  for (const [id, item] of moves.items) {
    context.items.set(id, item);
  }
  let needs: z.infer<typeof needSchema>[] = [];
  if (order.status === 'draft') {
    const [balances, reserved] = await Promise.all([
      tx.inventoryStock.balances({ locationId: order.locationId }),
      reservedAt(tx, { locationId: order.locationId }),
    ]);
    const onHand = new Map(balances.map((balance) => [balance.itemId, balance.onHand]));
    needs = moves.out.map((need) => {
      const held = onHand.get(need.itemId) ?? '0';
      const { reserved: promised, available } = availability(
        held,
        reserved.get(`${need.itemId}:${order.locationId}`),
      );
      const gap = shortBy(need.quantity, available);
      return {
        item: itemSummary(context.items.get(need.itemId)!),
        quantity: need.quantity,
        onHand: held,
        reserved: promised,
        available,
        short: gap,
      };
    });
  }
  const manage = holds(principal, 'manufacturing.manage');
  const draft = order.status === 'draft';
  return {
    ...(await orderBody(tx, principal, order, context)),
    needs,
    outputs: moves.in.map((output) => ({
      item: itemSummary(context.items.get(output.itemId)!),
      quantity: output.quantity,
    })),
    can: {
      edit: draft && manage,
      complete: draft && manage && needs.every((need) => need.short === '0'),
      cancel: draft && manage,
    },
  };
}

// ---------------------------------------------------------------------------
// Bills of materials
// ---------------------------------------------------------------------------

const itemParams = z.object({ itemId: z.uuid() });

export const listBomsRoute = defineRoute({
  method: 'get',
  path: '/v1/manufacturing/boms',
  operationId: 'listBoms',
  summary: 'Items built from a bill of materials',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page, by item name.',
      schema: z.object({
        items: z.array(
          z.object({
            id: z.uuid(),
            item: z.object({ id: z.uuid(), sku: z.string(), name: z.string() }),
            version: z.number().int(),
            components: z.number().int(),
            createdAt: z.iso.datetime(),
          }),
        ),
        total: z.number().int(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.manufacturing.listBoms({
        q: query.q,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      return {
        items: page.items.map((bom) => ({
          id: bom.id,
          item: { id: bom.itemId, sku: bom.itemSku, name: bom.itemName },
          version: bom.version,
          components: bom.components,
          createdAt: iso(bom.createdAt),
        })),
        total: page.total,
      };
    });
    return { status: 200, body };
  },
});

export const getBomRoute = defineRoute({
  method: 'get',
  path: '/v1/manufacturing/boms/items/:itemId',
  operationId: 'getItemBom',
  summary: 'An item’s bill of materials, and its earlier versions',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.read',
  feature: FEATURE,
  params: itemParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The bill in use (null when the item is not built) and every version.',
      schema: z.object({
        current: bomSchema.nullable(),
        versions: z.array(
          z.object({
            id: z.uuid(),
            version: z.number().int(),
            createdAt: z.iso.datetime(),
            superseded: z.boolean(),
          }),
        ),
      }),
    },
    404: { description: 'No such item.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const item = await tx.inventoryCatalogue.findItem(params.itemId);
      if (item === undefined) {
        throw notFound('No such item.');
      }
      const versions = await tx.manufacturing.bomVersions(item.id);
      const current = versions.find((bom) => bom.supersededAt === null);
      return {
        current: current === undefined ? null : await bomBody(tx, principal, current),
        versions: versions.map((bom) => ({
          id: bom.id,
          version: bom.version,
          createdAt: iso(bom.createdAt),
          superseded: bom.supersededAt !== null,
        })),
      };
    });
    return { status: 200, body };
  },
});

export const saveBomRoute = defineRoute({
  method: 'put',
  path: '/v1/manufacturing/boms/items/:itemId',
  operationId: 'saveItemBom',
  summary: 'Save a new version of an item’s bill of materials',
  description:
    'The version in use is kept, superseded, for orders that used it. Components are stock or non-stock items, each once, never the item itself or anything that contains it (422 `contains_itself`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.manage',
  feature: FEATURE,
  params: itemParams,
  query: noSchema,
  body: z.object({
    labourCost: decimalAmountSchema.default('0'),
    overheadCost: decimalAmountSchema.default('0'),
    note: z.string().trim().max(1000).nullable().optional(),
    components: z
      .array(z.object({ itemId: z.uuid(), quantity: positiveQuantitySchema }))
      .min(1)
      .max(200),
  }),
  responses: {
    200: { description: 'The new version.', schema: bomSchema },
    404: { description: 'No such item.' },
    422: { description: 'A component that cannot be one.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const item = await requireStockItem(tx, params.itemId, 'params.itemId');
      const ids = body.components.map((component) => component.itemId);
      if (new Set(ids).size !== ids.length) {
        throw unprocessable('duplicate_component', 'Each component appears once.');
      }
      const components = await itemsById(tx, ids);
      for (const id of ids) {
        const component = components.get(id);
        if (component === undefined) {
          throw new ApiError(404, 'item_not_found', 'A component does not exist.');
        }
        if (component.kind === 'service') {
          throw unprocessable(
            'component_kind',
            'A component is a stock or non-stock item; put labour in the labour cost.',
          );
        }
        if (component.archivedAt !== null) {
          throw unprocessable('item_archived', `${component.name} is archived.`);
        }
      }
      const bills = await tx.manufacturing.activeBoms();
      if (
        wouldContainItself(item.id, ids, (id) =>
          bills.get(id)?.components.map((component) => component.itemId),
        )
      ) {
        throw unprocessable(
          'contains_itself',
          'An item cannot be built from itself, or from anything built from it.',
        );
      }
      const bom = await tx.manufacturing.saveBom(
        item.id,
        {
          labourCost: body.labourCost,
          overheadCost: body.overheadCost,
          note: body.note === '' ? null : (body.note ?? null),
          components: body.components,
        },
        principal.userId,
      );
      await audit(tx, context, 'manufacturing.bom_saved', 'erp_item', item.id, {
        version: bom.version,
      });
      return bomBody(tx, principal, bom);
    });
    return { status: 200, body: saved };
  },
});

export const retireBomRoute = defineRoute({
  method: 'delete',
  path: '/v1/manufacturing/boms/items/:itemId',
  operationId: 'retireItemBom',
  summary: 'Stop building an item: its bill is superseded with nothing after it',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.manage',
  feature: FEATURE,
  params: itemParams,
  query: noSchema,
  body: noSchema,
  responses: { 204: { description: 'Retired.' }, 404: { description: 'No bill in use.' } },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      if (!(await tx.manufacturing.retireBom(params.itemId, principal.userId))) {
        throw notFound('This item has no bill of materials in use.');
      }
      await audit(tx, context, 'manufacturing.bom_retired', 'erp_item', params.itemId);
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const orderParams = z.object({ orderId: z.uuid() });

export const listAssemblyOrdersRoute = defineRoute({
  method: 'get',
  path: '/v1/manufacturing/orders',
  operationId: 'listAssemblyOrders',
  summary: 'Assembly and disassembly orders, latest first',
  description: '`q` finds an order by its number (`AO-000123` or `123`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    status: z
      .union([assemblyOrderStatusSchema, z.array(assemblyOrderStatusSchema)])
      .optional()
      .transform((value) => (value === undefined ? undefined : [value].flat())),
    itemId: z.uuid().optional(),
    q: z.string().trim().max(40).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({
        items: z.array(assemblyOrderSchema),
        nextCursor: z.string().nullable(),
        statuses: z.array(z.enum(ASSEMBLY_ORDER_STATUSES)),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const reference = query.q === undefined ? undefined : parseAssemblyReference(query.q);
      if (query.q !== undefined && query.q !== '' && reference === undefined) {
        return { items: [], nextCursor: null, statuses: [...ASSEMBLY_ORDER_STATUSES] };
      }
      const before = decodeDateCursor(query.cursor);
      const page = await tx.manufacturing.listOrders({
        statuses: query.status,
        itemId: query.itemId,
        reference,
        before:
          before === undefined ? undefined : { at: before.createdAt.toISOString(), id: before.id },
        limit: query.limit,
      });
      const ctx = await orderContext(tx, page.items);
      return {
        items: await Promise.all(page.items.map((order) => orderBody(tx, principal, order, ctx))),
        nextCursor: encodeDateCursor(
          page.next === undefined
            ? undefined
            : { createdAt: new Date(page.next.at), id: page.next.id },
        ),
        statuses: [...ASSEMBLY_ORDER_STATUSES],
      };
    });
    return { status: 200, body };
  },
});

export const getAssemblyOrderRoute = defineRoute({
  method: 'get',
  path: '/v1/manufacturing/orders/:orderId',
  operationId: 'getAssemblyOrder',
  summary: 'An order, with what it needs against what is there',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.read',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The order.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const order = await tx.manufacturing.order(params.orderId);
      if (order === undefined) {
        throw notFound('No such assembly order.');
      }
      return orderDetail(tx, principal, order);
    });
    return { status: 200, body };
  },
});

/** Drafts an order from the item's bill in use. Shared with planning. */
export async function draftAssemblyOrder(
  tx: TenantTransaction,
  context: RequestContext,
  input: {
    direction: 'assemble' | 'disassemble';
    itemId: string;
    locationId: string;
    quantity: string;
    note?: string | null | undefined;
    plannedFor?: string | null | undefined;
    planId?: string | null | undefined;
  },
): Promise<AssemblyOrder> {
  const item = await requireStockItem(tx, input.itemId);
  await requireLocation(tx, input.locationId);
  const bom = await tx.manufacturing.activeBom(item.id);
  if (bom === undefined) {
    throw unprocessable(
      'no_bill',
      'This item has no bill of materials; add one before building or taking it apart.',
    );
  }
  const order = await tx.manufacturing.createOrder(
    {
      direction: input.direction,
      itemId: item.id,
      bomId: bom.id,
      locationId: input.locationId,
      quantity: input.quantity,
      note: input.note ?? null,
      plannedFor: input.plannedFor ?? null,
      planId: input.planId ?? null,
    },
    context.principal.userId,
  );
  await audit(tx, context, 'manufacturing.order_drafted', 'erp_assembly_order', order.id, {
    reference: formatAssemblyReference(order.reference),
    direction: order.direction,
  });
  return order;
}

export const createAssemblyOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/manufacturing/orders',
  operationId: 'createAssemblyOrder',
  summary: 'Draft an assembly or disassembly order',
  description: 'From the item’s bill in use (422 `no_bill` when it has none).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    direction: assemblyDirectionSchema.default('assemble'),
    itemId: z.uuid(),
    locationId: z.uuid(),
    quantity: positiveQuantitySchema,
    note: z.string().trim().max(1000).nullable().optional(),
    plannedFor: z.iso.date().nullable().optional(),
  }),
  responses: {
    201: { description: 'The draft.', schema: orderDetailSchema },
    422: { description: 'No bill, or not a stock item.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) =>
      orderDetail(tx, principal, await draftAssemblyOrder(tx, context, body)),
    );
    return { status: 201, body: created };
  },
});

export const updateAssemblyOrderRoute = defineRoute({
  method: 'patch',
  path: '/v1/manufacturing/orders/:orderId',
  operationId: 'updateAssemblyOrder',
  summary: 'Change a draft: where, how many, when, or move it to the bill now in use',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().positive(),
    locationId: z.uuid().optional(),
    quantity: positiveQuantitySchema.optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    plannedFor: z.iso.date().nullable().optional(),
    useCurrentBill: z.boolean().optional(),
  }),
  responses: {
    200: { description: 'The order.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
    409: { description: 'Done already, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await tx.manufacturing.lockOrder(params.orderId);
      if (order === undefined) {
        throw notFound('No such assembly order.');
      }
      if (order.status !== 'draft') {
        throw conflict('order_closed', 'A completed or cancelled order does not change.');
      }
      if (body.locationId !== undefined) {
        await requireLocation(tx, body.locationId);
      }
      let bomId: string | undefined;
      if (body.useCurrentBill === true) {
        const bom = await tx.manufacturing.activeBom(order.itemId);
        if (bom === undefined) {
          throw unprocessable('no_bill', 'This item no longer has a bill of materials in use.');
        }
        bomId = bom.id;
      }
      const updated = await tx.manufacturing.updateDraft(order.id, body.expectedVersion, {
        ...(bomId === undefined ? {} : { bomId }),
        ...(body.locationId === undefined ? {} : { locationId: body.locationId }),
        ...(body.quantity === undefined ? {} : { quantity: body.quantity }),
        ...(body.note === undefined ? {} : { note: body.note === '' ? null : body.note }),
        ...(body.plannedFor === undefined ? {} : { plannedFor: body.plannedFor }),
      });
      if (updated === undefined) {
        throw versionConflict();
      }
      return orderDetail(tx, principal, updated);
    });
    return { status: 200, body: detail };
  },
});

export const completeAssemblyOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/manufacturing/orders/:orderId/complete',
  operationId: 'completeAssemblyOrder',
  summary: 'Complete an order: move its stock and set the item’s cost',
  description:
    'Refused, moving nothing, when anything it takes out is short at its location once sales orders’ reservations are kept (409 `shortage`, with what is short). Completing an order already completed returns it unchanged. Posts to the ledger when it is set up.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().positive() }),
  responses: {
    200: { description: 'The order.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
    409: { description: 'Short of stock, cancelled, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await tx.manufacturing.lockOrder(params.orderId);
      if (order === undefined) {
        throw notFound('No such assembly order.');
      }
      if (order.status === 'completed') {
        return orderDetail(tx, principal, order);
      }
      if (order.status === 'cancelled') {
        throw conflict('order_closed', 'This order was cancelled.');
      }
      if (order.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const completed = await completeOrder(tx, context, order);
      return orderDetail(tx, principal, completed);
    });
    return { status: 200, body: detail };
  },
});

async function completeOrder(
  tx: TenantTransaction,
  context: RequestContext,
  order: AssemblyOrder,
): Promise<AssemblyOrder> {
  const bom = await tx.manufacturing.bom(order.bomId);
  if (bom === undefined) {
    throw notFound('No such bill of materials.');
  }
  const moves = await movementsOf(tx, order, bom);
  // Each balance taken from is locked, in one order, before anything moves.
  const shortages: { itemId: string; short: string }[] = [];
  const reserved = await reservedAt(tx, { locationId: order.locationId });
  for (const need of [...moves.out].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const held = await tx.inventoryStock.lockBalance(need.itemId, order.locationId);
    const { available } = availability(held, reserved.get(`${need.itemId}:${order.locationId}`));
    const gap = shortBy(need.quantity, available);
    if (gap !== '0') {
      shortages.push({ itemId: need.itemId, short: gap });
    }
  }
  if (shortages.length > 0) {
    throw new ApiError(
      409,
      'shortage',
      'There is not enough stock at this location to complete it. Nothing was moved.',
      shortages.map((shortage) => ({
        field: `items.${shortage.itemId}`,
        code: 'shortage',
        message: `${moves.items.get(shortage.itemId)?.name ?? 'An item'} is short by ${shortage.short}.`,
      })),
    );
  }

  const costOf = (itemId: string) => {
    const item = moves.items.get(itemId);
    return item === undefined ? '0' : currentCost(item);
  };
  const componentCosts = new Map(
    bom.components.map((component) => [component.itemId, costOf(component.itemId)]),
  );
  const movements: MovementInput[] = [];
  const source = (itemId: string) => `assembly:${order.id}:${itemId}`;
  let unitCost: string;
  if (order.direction === 'assemble') {
    unitCost = rolledUpUnitCost(bom.components, componentCosts, bom.labourCost, bom.overheadCost);
    for (const need of moves.out) {
      movements.push({
        itemId: need.itemId,
        locationId: order.locationId,
        kind: 'assembly_consumption',
        quantity: `-${need.quantity}`,
        unitCost: costOf(need.itemId),
        sourceKey: source(need.itemId),
      });
    }
    // The finished units join the item's average cost before they arrive.
    await tx.inventoryStock.applyReceiptCost(order.itemId, order.quantity, unitCost);
    movements.push({
      itemId: order.itemId,
      locationId: order.locationId,
      kind: 'assembly_output',
      quantity: order.quantity,
      unitCost,
      sourceKey: source(order.itemId),
    });
  } else {
    unitCost = costOf(order.itemId);
    const shares = disassemblyUnitCosts(moves.in, componentCosts, order.quantity, unitCost);
    movements.push({
      itemId: order.itemId,
      locationId: order.locationId,
      kind: 'assembly_consumption',
      quantity: `-${order.quantity}`,
      unitCost,
      sourceKey: source(order.itemId),
    });
    for (const output of moves.in) {
      const share = shares.get(output.itemId) ?? '0';
      await tx.inventoryStock.applyReceiptCost(output.itemId, output.quantity, share);
      movements.push({
        itemId: output.itemId,
        locationId: order.locationId,
        kind: 'assembly_output',
        quantity: output.quantity,
        unitCost: share,
        sourceKey: source(output.itemId),
      });
    }
  }
  try {
    await tx.inventoryStock.post(movements, {
      postingId: order.id,
      actorId: context.principal.userId,
    });
  } catch (error) {
    stockRefusal(error);
  }
  const completed = await tx.manufacturing.complete(
    order.id,
    order.version,
    context.principal.userId,
    {
      unitCost,
      labourCost: order.direction === 'assemble' ? bom.labourCost : null,
      overheadCost: order.direction === 'assemble' ? bom.overheadCost : null,
    },
  );
  if (completed === undefined) {
    throw versionConflict();
  }
  await audit(tx, context, 'manufacturing.order_completed', 'erp_assembly_order', order.id, {
    reference: formatAssemblyReference(order.reference),
    direction: order.direction,
    quantity: order.quantity,
    value: multiplyDecimal(order.quantity, unitCost),
  });
  return completed;
}

export const cancelAssemblyOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/manufacturing/orders/:orderId/cancel',
  operationId: 'cancelAssemblyOrder',
  summary: 'Cancel a draft order',
  tags: TAGS,
  security: 'authenticated',
  permission: 'manufacturing.manage',
  feature: FEATURE,
  params: orderParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().positive() }),
  responses: {
    200: { description: 'The order.', schema: orderDetailSchema },
    404: { description: 'No such order.' },
    409: { description: 'Done already, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await tx.manufacturing.lockOrder(params.orderId);
      if (order === undefined) {
        throw notFound('No such assembly order.');
      }
      if (order.status !== 'draft') {
        throw conflict('order_closed', 'A completed or cancelled order does not change.');
      }
      const cancelled = await tx.manufacturing.cancel(
        order.id,
        body.expectedVersion,
        principal.userId,
      );
      if (cancelled === undefined) {
        throw versionConflict();
      }
      await audit(tx, context, 'manufacturing.order_cancelled', 'erp_assembly_order', order.id, {
        reference: formatAssemblyReference(order.reference),
      });
      return orderDetail(tx, principal, cancelled);
    });
    return { status: 200, body: detail };
  },
});

export const manufacturingRoutes = [
  listBomsRoute,
  getBomRoute,
  saveBomRoute,
  retireBomRoute,
  listAssemblyOrdersRoute,
  getAssemblyOrderRoute,
  createAssemblyOrderRoute,
  updateAssemblyOrderRoute,
  completeAssemblyOrderRoute,
  cancelAssemblyOrderRoute,
];
