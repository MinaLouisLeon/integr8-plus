import {
  type AssemblyDirection,
  type AssemblyOrderStatus,
  type BomComponent,
  toUserId,
  type UserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  ErpAssemblyOrdersTable,
  ErpBomsTable,
  ErpMrpPlansTable,
  ErpMrpSuggestionsTable,
} from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Bills of materials, assembly and disassembly orders, and planning (0039;
 * ADR-0011). A bill version never changes: saving one supersedes the version
 * in use. An order is drafted, then completed or cancelled once; completing
 * it writes its stock movements (in the API, through the stock ledger) with
 * the order's id as their posting. A plan is a snapshot.
 */

export interface Bom {
  id: string;
  itemId: string;
  version: number;
  labourCost: string;
  overheadCost: string;
  note: string | null;
  components: BomComponent[];
  createdBy: UserId;
  createdAt: Date;
  supersededAt: Date | null;
}

export interface BomInput {
  labourCost: string;
  overheadCost: string;
  note: string | null;
  components: readonly BomComponent[];
}

export interface BomSummary {
  id: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  version: number;
  components: number;
  createdAt: Date;
}

export interface AssemblyOrder {
  id: string;
  reference: number;
  direction: AssemblyDirection;
  itemId: string;
  bomId: string;
  locationId: string;
  quantity: string;
  status: AssemblyOrderStatus;
  plannedFor: string | null;
  planId: string | null;
  note: string | null;
  unitCost: string | null;
  labourCost: string | null;
  overheadCost: string | null;
  createdBy: UserId;
  createdAt: Date;
  completedBy: UserId | null;
  completedAt: Date | null;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
  version: number;
}

export interface AssemblyOrderInput {
  direction: AssemblyDirection;
  itemId: string;
  bomId: string;
  locationId: string;
  quantity: string;
  note?: string | null;
  plannedFor?: string | null;
  planId?: string | null;
}

export interface AssemblyOrderQuery {
  statuses?: readonly AssemblyOrderStatus[] | undefined;
  itemId?: string | undefined;
  reference?: number | undefined;
  before?: { at: string; id: string } | undefined;
  limit: number;
}

export interface MrpPlan {
  id: string;
  horizonEnd: string;
  runBy: UserId;
  runAt: Date;
}

export interface MrpSuggestion {
  id: string;
  planId: string;
  itemId: string;
  action: 'build' | 'buy';
  level: number;
  required: string;
  available: string;
  onOrder: string;
  reorderMinimum: string;
  quantity: string;
  needBy: string;
  orderBy: string;
  leadTimeDays: number;
  supplierId: string | null;
  bomId: string | null;
  basis: string;
  draftedKind: 'assembly_order' | 'purchase_order' | null;
  draftedId: string | null;
  draftedAt: Date | null;
}

export type MrpSuggestionInput = Omit<
  MrpSuggestion,
  'id' | 'planId' | 'draftedKind' | 'draftedId' | 'draftedAt'
>;

function toOrder(row: Selectable<ErpAssemblyOrdersTable>): AssemblyOrder {
  return {
    id: row.id,
    reference: row.reference,
    direction: row.direction,
    itemId: row.item_id,
    bomId: row.bom_id,
    locationId: row.location_id,
    quantity: trimDecimal(row.quantity),
    status: row.status,
    plannedFor: toDayString(row.planned_for),
    planId: row.plan_id,
    note: row.note,
    unitCost: row.unit_cost === null ? null : trimDecimal(row.unit_cost),
    labourCost: row.labour_cost === null ? null : trimDecimal(row.labour_cost),
    overheadCost: row.overhead_cost === null ? null : trimDecimal(row.overhead_cost),
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    completedBy: row.completed_by === null ? null : toUserId(row.completed_by),
    completedAt: row.completed_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    version: row.version,
  };
}

function toPlan(row: Selectable<ErpMrpPlansTable>): MrpPlan {
  return {
    id: row.id,
    horizonEnd: toDayString(row.horizon_end) ?? '',
    runBy: toUserId(row.run_by),
    runAt: row.run_at,
  };
}

function toSuggestion(row: Selectable<ErpMrpSuggestionsTable>): MrpSuggestion {
  return {
    id: row.id,
    planId: row.plan_id,
    itemId: row.item_id,
    action: row.action,
    level: row.level,
    required: trimDecimal(row.required),
    available: trimDecimal(row.available),
    onOrder: trimDecimal(row.on_order),
    reorderMinimum: trimDecimal(row.reorder_minimum),
    quantity: trimDecimal(row.quantity),
    needBy: toDayString(row.need_by) ?? '',
    orderBy: toDayString(row.order_by) ?? '',
    leadTimeDays: row.lead_time_days,
    supplierId: row.supplier_id,
    bomId: row.bom_id,
    basis: row.basis,
    draftedKind: row.drafted_kind,
    draftedId: row.drafted_id,
    draftedAt: row.drafted_at,
  };
}

export class ManufacturingRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Bills of materials
  // -------------------------------------------------------------------------

  async #withComponents(rows: Selectable<ErpBomsTable>[]): Promise<Bom[]> {
    if (rows.length === 0) {
      return [];
    }
    const components = await this.db
      .selectFrom('erp_bom_components')
      .select(['bom_id', 'item_id', 'quantity'])
      .where('tenant_id', '=', this.tenantId)
      .where(
        'bom_id',
        'in',
        rows.map((row) => row.id),
      )
      .orderBy('bom_id')
      .orderBy('line_no')
      .execute();
    const byBom = new Map<string, BomComponent[]>();
    for (const component of components) {
      byBom.set(component.bom_id, [
        ...(byBom.get(component.bom_id) ?? []),
        { itemId: component.item_id, quantity: trimDecimal(component.quantity) },
      ]);
    }
    return rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      version: row.version,
      labourCost: trimDecimal(row.labour_cost),
      overheadCost: trimDecimal(row.overhead_cost),
      note: row.note,
      components: byBom.get(row.id) ?? [],
      createdBy: toUserId(row.created_by),
      createdAt: row.created_at,
      supersededAt: row.superseded_at,
    }));
  }

  async bom(id: string): Promise<Bom | undefined> {
    const rows = await this.db
      .selectFrom('erp_boms')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .execute();
    return (await this.#withComponents(rows))[0];
  }

  async activeBom(itemId: string): Promise<Bom | undefined> {
    const rows = await this.db
      .selectFrom('erp_boms')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .where('superseded_at', 'is', null)
      .execute();
    return (await this.#withComponents(rows))[0];
  }

  /** Every version of an item's bill, latest first. */
  async bomVersions(itemId: string): Promise<Bom[]> {
    const rows = await this.db
      .selectFrom('erp_boms')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .orderBy('version', 'desc')
      .execute();
    return this.#withComponents(rows);
  }

  /** Every bill in use, by item: for checking an item never contains itself, and for planning. */
  async activeBoms(): Promise<Map<string, Bom>> {
    const rows = await this.db
      .selectFrom('erp_boms')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('superseded_at', 'is', null)
      .execute();
    return new Map((await this.#withComponents(rows)).map((bom) => [bom.itemId, bom]));
  }

  /** Items with a bill in use, by name. */
  async listBoms(query: {
    q?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ items: BomSummary[]; total: number }> {
    let select = this.db
      .selectFrom('erp_boms as b')
      .innerJoin('erp_items as i', (join) =>
        join.onRef('i.tenant_id', '=', 'b.tenant_id').onRef('i.id', '=', 'b.item_id'),
      )
      .where('b.tenant_id', '=', this.tenantId)
      .where('b.superseded_at', 'is', null);
    if (query.q !== undefined && query.q.trim() !== '') {
      const words = `%${query.q.trim().replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      select = select.where((eb) =>
        eb.or([eb('i.name', 'ilike', words), eb('i.sku', 'ilike', words)]),
      );
    }
    const [rows, total] = await Promise.all([
      select
        .select([
          'b.id',
          'b.item_id',
          'b.version',
          'b.created_at',
          'i.name',
          'i.sku',
          sql<number>`(select count(*)::int from erp_bom_components c where c.tenant_id = b.tenant_id and c.bom_id = b.id)`.as(
            'components',
          ),
        ])
        .orderBy(sql`lower(i.name)`)
        .orderBy('b.id')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      select.select(sql<number>`count(*)::int`.as('n')).executeTakeFirst(),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        itemId: row.item_id,
        itemName: row.name,
        itemSku: row.sku,
        version: row.version,
        components: row.components,
        createdAt: row.created_at,
      })),
      total: total?.n ?? 0,
    };
  }

  /**
   * A new version of an item's bill, superseding the one in use. The item's
   * row is locked first, so two saves of one bill number one after the other.
   */
  async saveBom(itemId: string, input: BomInput, by: UserId | string): Promise<Bom> {
    await this.db
      .selectFrom('erp_items')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', itemId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const latest = await this.db
      .selectFrom('erp_boms')
      .select(sql<number>`coalesce(max(version), 0)`.as('version'))
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();
    await this.#supersede(itemId, by);
    const row = await this.db
      .insertInto('erp_boms')
      .values({
        tenant_id: this.tenantId,
        item_id: itemId,
        version: (latest?.version ?? 0) + 1,
        labour_cost: input.labourCost,
        overhead_cost: input.overheadCost,
        note: input.note,
        created_by: toUserId(by),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.db
      .insertInto('erp_bom_components')
      .values(
        input.components.map((component, index) => ({
          tenant_id: this.tenantId,
          bom_id: row.id,
          line_no: index + 1,
          item_id: component.itemId,
          quantity: component.quantity,
        })),
      )
      .execute();
    return (await this.bom(row.id))!;
  }

  async #supersede(itemId: string, by: UserId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('erp_boms')
      .set({ superseded_at: sql<Date>`now()`, superseded_by: toUserId(by) })
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .where('superseded_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** The item is no longer built: its bill is superseded with nothing after it. */
  retireBom(itemId: string, by: UserId | string): Promise<boolean> {
    return this.#supersede(itemId, by);
  }

  // -------------------------------------------------------------------------
  // Assembly and disassembly orders
  // -------------------------------------------------------------------------

  async order(id: string): Promise<AssemblyOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_assembly_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  async lockOrder(id: string): Promise<AssemblyOrder | undefined> {
    const row = await this.db
      .selectFrom('erp_assembly_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  /** Drafts, by item: what open orders will consume and make, for planning. */
  async draftOrders(): Promise<AssemblyOrder[]> {
    const rows = await this.db
      .selectFrom('erp_assembly_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'draft')
      .execute();
    return rows.map(toOrder);
  }

  /** Latest first. */
  async listOrders(query: AssemblyOrderQuery): Promise<{
    items: AssemblyOrder[];
    next?: { at: string; id: string };
  }> {
    let select = this.db
      .selectFrom('erp_assembly_orders')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.itemId !== undefined) {
      select = select.where('item_id', '=', query.itemId);
    }
    if (query.reference !== undefined) {
      select = select.where('reference', '=', query.reference);
    }
    if (query.before !== undefined) {
      select = select.where(
        sql<boolean>`(created_at, id) < (${query.before.at}::timestamptz, ${query.before.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const items = rows.slice(0, query.limit).map(toOrder);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { at: last.createdAt.toISOString(), id: last.id } }
        : {}),
    };
  }

  async createOrder(input: AssemblyOrderInput, by: UserId | string): Promise<AssemblyOrder> {
    const row = await this.db
      .insertInto('erp_assembly_orders')
      .values({
        tenant_id: this.tenantId,
        direction: input.direction,
        item_id: input.itemId,
        bom_id: input.bomId,
        location_id: input.locationId,
        quantity: input.quantity,
        note: input.note ?? null,
        planned_for: input.plannedFor ?? null,
        plan_id: input.planId ?? null,
        created_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOrder(row);
  }

  async updateDraft(
    id: string,
    expectedVersion: number,
    input: {
      bomId?: string;
      locationId?: string;
      quantity?: string;
      note?: string | null;
      plannedFor?: string | null;
    },
  ): Promise<AssemblyOrder | undefined> {
    const row = await this.db
      .updateTable('erp_assembly_orders')
      .set({
        ...(input.bomId === undefined ? {} : { bom_id: input.bomId }),
        ...(input.locationId === undefined ? {} : { location_id: input.locationId }),
        ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.plannedFor === undefined ? {} : { planned_for: input.plannedFor }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  /** Records completion; the caller has already written the movements. */
  async complete(
    id: string,
    expectedVersion: number,
    by: UserId | string,
    costs: { unitCost: string; labourCost: string | null; overheadCost: string | null },
  ): Promise<AssemblyOrder | undefined> {
    const row = await this.db
      .updateTable('erp_assembly_orders')
      .set({
        status: 'completed',
        completed_by: toUserId(by),
        completed_at: sql<Date>`now()`,
        unit_cost: costs.unitCost,
        labour_cost: costs.labourCost,
        overhead_cost: costs.overheadCost,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  async cancel(
    id: string,
    expectedVersion: number,
    by: UserId | string,
  ): Promise<AssemblyOrder | undefined> {
    const row = await this.db
      .updateTable('erp_assembly_orders')
      .set({
        status: 'cancelled',
        cancelled_by: toUserId(by),
        cancelled_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toOrder(row);
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  async savePlan(
    horizonEnd: string,
    by: UserId | string,
    suggestions: readonly MrpSuggestionInput[],
  ): Promise<MrpPlan> {
    const row = await this.db
      .insertInto('erp_mrp_plans')
      .values({ tenant_id: this.tenantId, horizon_end: horizonEnd, run_by: toUserId(by) })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (suggestions.length > 0) {
      await this.db
        .insertInto('erp_mrp_suggestions')
        .values(
          suggestions.map((suggestion) => ({
            tenant_id: this.tenantId,
            plan_id: row.id,
            item_id: suggestion.itemId,
            action: suggestion.action,
            level: suggestion.level,
            required: suggestion.required,
            available: suggestion.available,
            on_order: suggestion.onOrder,
            reorder_minimum: suggestion.reorderMinimum,
            quantity: suggestion.quantity,
            need_by: suggestion.needBy,
            order_by: suggestion.orderBy,
            lead_time_days: suggestion.leadTimeDays,
            supplier_id: suggestion.supplierId,
            bom_id: suggestion.bomId,
            basis: suggestion.basis,
          })),
        )
        .execute();
    }
    return toPlan(row);
  }

  async plan(id: string): Promise<MrpPlan | undefined> {
    const row = await this.db
      .selectFrom('erp_mrp_plans')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPlan(row);
  }

  async plans(limit: number): Promise<MrpPlan[]> {
    const rows = await this.db
      .selectFrom('erp_mrp_plans')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .orderBy('run_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toPlan);
  }

  async suggestions(planId: string): Promise<MrpSuggestion[]> {
    const rows = await this.db
      .selectFrom('erp_mrp_suggestions')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('plan_id', '=', planId)
      .orderBy('level')
      .orderBy('order_by')
      .orderBy('id')
      .execute();
    return rows.map(toSuggestion);
  }

  /** Locked, so two people drafting from one plan draft each suggestion once. */
  async lockSuggestions(ids: readonly string[]): Promise<MrpSuggestion[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_mrp_suggestions')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(ids)])
      .orderBy('id')
      .forUpdate()
      .execute();
    return rows.map(toSuggestion);
  }

  async markDrafted(
    ids: readonly string[],
    kind: 'assembly_order' | 'purchase_order',
    draftedId: string,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .updateTable('erp_mrp_suggestions')
      .set({ drafted_kind: kind, drafted_id: draftedId, drafted_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...ids])
      .where('drafted_id', 'is', null)
      .execute();
  }
}
