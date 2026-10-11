import {
  type LocationKind,
  type MovementKind,
  type StockCountStatus,
  type UserId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  ErpStockCountsTable,
  ErpStockLocationsTable,
  ErpStockMovementsTable,
} from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Where stock is and how it moves (CRM/ERP plan, phase E1; ADR-0003).
 *
 * The ledger is written here and only here, by `post`. Balances are read,
 * never written: the ledger's trigger maintains them, and the database refuses
 * any movement that would take one below zero. `reconcile` replays the whole
 * ledger and reports any balance that disagrees with it.
 */

export interface StockLocation {
  id: string;
  name: string;
  kind: LocationKind;
  /** A van's engineer. */
  assignedTo: UserId | null;
  /** A site location's customer site. */
  siteId: string | null;
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface LocationInput {
  name: string;
  kind: LocationKind;
  assignedTo?: UserId | string | null;
  siteId?: string | null;
  notes?: string | null;
}

export interface MovementInput {
  itemId: string;
  locationId: string;
  kind: MovementKind;
  /** Signed decimal string: positive adds stock at the location. */
  quantity: string;
  unitCost?: string | null;
  /** Unique per company: the same posting is never written twice. */
  sourceKey: string;
  reason?: string | null;
  stockCountId?: string | null;
  reversalOf?: string | null;
}

export interface Movement {
  id: string;
  postingId: string;
  itemId: string;
  locationId: string;
  kind: MovementKind;
  quantity: string;
  unitCost: string | null;
  sourceKey: string;
  reason: string | null;
  stockCountId: string | null;
  reversalOf: string | null;
  actorId: UserId;
  occurredAt: Date;
}

export interface MovementQuery {
  itemId?: string;
  locationId?: string;
  kinds?: readonly MovementKind[];
  after?: { occurredAt: Date; id: string };
  limit?: number;
}

export interface MovementPage {
  items: Movement[];
  next: { occurredAt: Date; id: string } | undefined;
}

export interface Balance {
  itemId: string;
  locationId: string;
  onHand: string;
  /** The reorder level at this location, if one is set. */
  minimum: string | null;
}

export interface StockCount {
  id: string;
  locationId: string;
  status: StockCountStatus;
  notes: string | null;
  version: number;
  createdBy: UserId;
  postedBy: UserId | null;
  postedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockCountLine {
  itemId: string;
  countedQuantity: string;
  /** What the system held when the count was posted; null while it is a draft. */
  expectedQuantity: string | null;
}

export interface Discrepancy {
  itemId: string;
  locationId: string;
  /** What the ledger adds up to. */
  ledger: string;
  /** What the balance says. */
  balance: string;
}

/** A movement would take stock below zero somewhere. Nothing was written. */
export class InsufficientStockError extends Error {
  constructor() {
    super('Not enough stock for this movement');
    this.name = 'InsufficientStockError';
  }
}

/** This posting has been written before (same `source_key`). Nothing was written. */
export class DuplicatePostingError extends Error {
  constructor() {
    super('This stock posting has already been made');
    this.name = 'DuplicatePostingError';
  }
}

/** Only stock items have stock; a service or non-stock item cannot move. */
export class NotStockItemError extends Error {
  constructor() {
    super('Only stock items have stock');
    this.name = 'NotStockItemError';
  }
}

export type StockRefusal = 'not_found' | 'version_conflict';

export class InventoryStockRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Locations
  // -------------------------------------------------------------------------

  async createLocation(input: LocationInput): Promise<StockLocation> {
    const row = await this.db
      .insertInto('erp_stock_locations')
      .values({
        tenant_id: this.tenantId,
        name: input.name.trim(),
        kind: input.kind,
        assigned_to:
          input.assignedTo === undefined || input.assignedTo === null
            ? null
            : toUserId(input.assignedTo),
        site_id: input.siteId ?? null,
        notes: blankToNull(input.notes) ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toLocation(row);
  }

  async findLocation(locationId: string): Promise<StockLocation | undefined> {
    const row = await this.db
      .selectFrom('erp_stock_locations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', locationId)
      .executeTakeFirst();
    return row === undefined ? undefined : toLocation(row);
  }

  async findLocations(locationIds: readonly string[]): Promise<StockLocation[]> {
    if (locationIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_stock_locations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(locationIds)])
        .execute()
    ).map(toLocation);
  }

  /** Warehouses first, then vans, then sites; alphabetical within each. */
  async listLocations(
    query: { kinds?: readonly LocationKind[]; includeArchived?: boolean } = {},
  ): Promise<StockLocation[]> {
    let select = this.db
      .selectFrom('erp_stock_locations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.kinds !== undefined && query.kinds.length > 0) {
      select = select.where('kind', 'in', [...query.kinds]);
    }
    if (query.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    return (
      await select
        .orderBy(sql`case kind when 'warehouse' then 0 when 'van' then 1 else 2 end`)
        .orderBy(sql`lower(name)`)
        .limit(500)
        .execute()
    ).map(toLocation);
  }

  /** The van assigned to this member, if they have one. */
  async vanOf(userId: UserId | string): Promise<StockLocation | undefined> {
    const row = await this.db
      .selectFrom('erp_stock_locations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('kind', '=', 'van')
      .where('assigned_to', '=', toUserId(userId))
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toLocation(row);
  }

  async updateLocation(
    locationId: string,
    expectedVersion: number,
    input: {
      name?: string;
      assignedTo?: UserId | string | null;
      notes?: string | null;
      archived?: boolean;
    },
  ): Promise<StockLocation | StockRefusal> {
    const row = await this.db
      .updateTable('erp_stock_locations')
      .set({
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.assignedTo === undefined
          ? {}
          : { assigned_to: input.assignedTo === null ? null : toUserId(input.assignedTo) }),
        ...(input.notes === undefined ? {} : { notes: blankToNull(input.notes) ?? null }),
        ...(input.archived === undefined
          ? {}
          : { archived_at: input.archived ? sql<Date>`coalesce(archived_at, now())` : null }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', locationId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return toLocation(row);
    }
    return (await this.findLocation(locationId)) === undefined ? 'not_found' : 'version_conflict';
  }

  // -------------------------------------------------------------------------
  // The ledger
  // -------------------------------------------------------------------------

  /**
   * Writes movements to the ledger, together, in one statement. Their balances
   * follow by trigger. Refuses — writing nothing — when any would take stock
   * below zero, repeats a `sourceKey`, or moves something that is not a stock
   * item.
   */
  async post(
    movements: readonly MovementInput[],
    meta: { postingId: string; actorId: UserId | string },
  ): Promise<Movement[]> {
    if (movements.length === 0) {
      return [];
    }
    try {
      const rows = await this.db
        .insertInto('erp_stock_movements')
        .values(
          movements.map((movement) => ({
            tenant_id: this.tenantId,
            posting_id: meta.postingId,
            item_id: movement.itemId,
            location_id: movement.locationId,
            kind: movement.kind,
            quantity: movement.quantity,
            unit_cost: movement.unitCost ?? null,
            source_key: movement.sourceKey,
            reason: blankToNull(movement.reason) ?? null,
            stock_count_id: movement.stockCountId ?? null,
            reversal_of: movement.reversalOf ?? null,
            actor_id: toUserId(meta.actorId),
          })),
        )
        .returningAll()
        .execute();
      return rows.map(toMovement);
    } catch (error) {
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === '23514' && constraint === 'erp_stock_balances_not_negative') {
        throw new InsufficientStockError();
      }
      if (code === '23505' && constraint === 'erp_stock_movements_source_unique') {
        throw new DuplicatePostingError();
      }
      if (code === '23514' && constraint === 'erp_stock_movements_stock_items_only') {
        throw new NotStockItemError();
      }
      throw error;
    }
  }

  /**
   * How much of an item is at a location, with that balance locked until the
   * transaction ends: nobody else can move it in between. Zero when nothing
   * has ever been there.
   */
  async lockBalance(itemId: string, locationId: string): Promise<string> {
    // Through a security-definer function: the runtime role may only read
    // balances, and a lock needs more. It refuses another company's row.
    const { rows } = await sql<{ held: string }>`
      select erp_stock_lock_balance(${this.tenantId}::uuid, ${itemId}::uuid, ${locationId}::uuid)::text as held
    `.execute(this.db);
    return trimDecimal(rows[0]!.held);
  }

  /**
   * Folds a receipt into the item's weighted average cost, before the receipt
   * is posted: `(on hand × average + received × cost) ÷ (on hand + received)`,
   * in `numeric`, rounded once to four places. The item's row is locked first,
   * so two receipts of one item apply one after the other, each seeing the
   * other's stock.
   */
  async applyReceiptCost(itemId: string, quantity: string, unitCost: string): Promise<string> {
    await this.db
      .selectFrom('erp_items')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', itemId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const held = sql<string>`coalesce((select sum(b.on_hand) from erp_stock_balances b where b.tenant_id = erp_items.tenant_id and b.item_id = erp_items.id), 0)`;
    const row = await this.db
      .updateTable('erp_items')
      .set({
        average_unit_cost: sql<string>`round((${held} * average_unit_cost + ${quantity}::numeric * ${unitCost}::numeric) / (${held} + ${quantity}::numeric), 4)`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', itemId)
      .returning('average_unit_cost')
      .executeTakeFirstOrThrow();
    return trimDecimal(row.average_unit_cost);
  }

  /** Newest first, a page at a time. */
  async listMovements(query: MovementQuery = {}): Promise<MovementPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let select = this.db
      .selectFrom('erp_stock_movements')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.itemId !== undefined) {
      select = select.where('item_id', '=', query.itemId);
    }
    if (query.locationId !== undefined) {
      select = select.where('location_id', '=', query.locationId);
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      select = select.where('kind', 'in', [...query.kinds]);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(date_trunc('milliseconds', occurred_at), id) < (${query.after.occurredAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy(sql`date_trunc('milliseconds', occurred_at)`, 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toMovement);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { occurredAt: last.occurredAt, id: last.id }
          : undefined,
    };
  }

  async findMovements(movementIds: readonly string[]): Promise<Movement[]> {
    if (movementIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_stock_movements')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(movementIds)])
        .execute()
    ).map(toMovement);
  }

  // -------------------------------------------------------------------------
  // Balances and reorder levels
  // -------------------------------------------------------------------------

  /**
   * Balances with their reorder levels. `belowMinimum` lists every item and
   * location with a reorder level that holds less than it, nothing included.
   */
  async balances(
    query: { itemId?: string; locationId?: string; belowMinimum?: boolean; limit?: number } = {},
  ): Promise<Balance[]> {
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 2000);
    const filters = [
      ...(query.itemId === undefined ? [] : [sql`item_id = ${query.itemId}::uuid`]),
      ...(query.locationId === undefined ? [] : [sql`location_id = ${query.locationId}::uuid`]),
    ];
    const where = filters.length === 0 ? sql`true` : sql.join(filters, sql` and `);
    const { rows } = await sql<{
      item_id: string;
      location_id: string;
      on_hand: string;
      minimum: string | null;
    }>`
      select coalesce(b.item_id, r.item_id) as item_id,
             coalesce(b.location_id, r.location_id) as location_id,
             coalesce(b.on_hand, 0)::text as on_hand,
             r.minimum::text as minimum
        from (select * from erp_stock_balances where tenant_id = ${this.tenantId} and ${where}) b
        full outer join (select * from erp_reorder_levels where tenant_id = ${this.tenantId} and ${where}) r
          on r.item_id = b.item_id and r.location_id = b.location_id
       where ${
         query.belowMinimum === true
           ? sql`r.minimum is not null and coalesce(b.on_hand, 0) < r.minimum`
           : sql`coalesce(b.on_hand, 0) <> 0 or r.minimum is not null`
       }
       limit ${limit}
    `.execute(this.db);
    return rows.map((row) => ({
      itemId: row.item_id,
      locationId: row.location_id,
      onHand: trimDecimal(row.on_hand),
      minimum: row.minimum === null ? null : trimDecimal(row.minimum),
    }));
  }

  /** Replaces an item's reorder levels with these. */
  async setReorderLevels(
    itemId: string,
    levels: readonly { locationId: string; minimum: string }[],
  ): Promise<void> {
    await this.db
      .deleteFrom('erp_reorder_levels')
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .execute();
    if (levels.length > 0) {
      await this.db
        .insertInto('erp_reorder_levels')
        .values(
          levels.map((level) => ({
            tenant_id: this.tenantId,
            item_id: itemId,
            location_id: level.locationId,
            minimum: level.minimum,
          })),
        )
        .execute();
    }
  }

  // -------------------------------------------------------------------------
  // Stock counts
  // -------------------------------------------------------------------------

  async createCount(
    locationId: string,
    createdBy: UserId | string,
    notes: string | null = null,
  ): Promise<StockCount> {
    const row = await this.db
      .insertInto('erp_stock_counts')
      .values({
        tenant_id: this.tenantId,
        location_id: locationId,
        created_by: toUserId(createdBy),
        notes: blankToNull(notes) ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCount(row);
  }

  async findCount(countId: string): Promise<StockCount | undefined> {
    const row = await this.db
      .selectFrom('erp_stock_counts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', countId)
      .executeTakeFirst();
    return row === undefined ? undefined : toCount(row);
  }

  async countLines(countId: string): Promise<StockCountLine[]> {
    return (
      await this.db
        .selectFrom('erp_stock_count_lines')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('count_id', '=', countId)
        .execute()
    ).map((row) => ({
      itemId: row.item_id,
      countedQuantity: trimDecimal(row.counted_quantity),
      expectedQuantity: row.expected_quantity === null ? null : trimDecimal(row.expected_quantity),
    }));
  }

  /** Newest first. */
  async listCounts(
    query: { locationId?: string; statuses?: readonly StockCountStatus[]; limit?: number } = {},
  ): Promise<StockCount[]> {
    let select = this.db
      .selectFrom('erp_stock_counts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.locationId !== undefined) {
      select = select.where('location_id', '=', query.locationId);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    return (
      await select
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
        .execute()
    ).map(toCount);
  }

  /**
   * Replaces a draft count's lines, provided nobody has changed the count
   * since `expectedVersion`. Refuses a count that is no longer a draft.
   */
  async setCountLines(
    countId: string,
    expectedVersion: number,
    lines: readonly { itemId: string; countedQuantity: string }[],
  ): Promise<StockCount | StockRefusal | 'not_draft'> {
    const count = await this.#lockCount(countId);
    if (count === undefined) {
      return 'not_found';
    }
    if (count.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (count.status !== 'draft') {
      return 'not_draft';
    }
    await this.db
      .deleteFrom('erp_stock_count_lines')
      .where('tenant_id', '=', this.tenantId)
      .where('count_id', '=', countId)
      .execute();
    if (lines.length > 0) {
      await this.db
        .insertInto('erp_stock_count_lines')
        .values(
          lines.map((line) => ({
            tenant_id: this.tenantId,
            count_id: countId,
            item_id: line.itemId,
            counted_quantity: line.countedQuantity,
          })),
        )
        .execute();
    }
    return toCount(
      await this.db
        .updateTable('erp_stock_counts')
        .set({ version: sql<number>`version + 1` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', countId)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Cancels a draft count. */
  async cancelCount(
    countId: string,
    expectedVersion: number,
  ): Promise<StockCount | StockRefusal | 'not_draft'> {
    const count = await this.#lockCount(countId);
    if (count === undefined) {
      return 'not_found';
    }
    if (count.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (count.status !== 'draft') {
      return 'not_draft';
    }
    return toCount(
      await this.db
        .updateTable('erp_stock_counts')
        .set({ status: 'cancelled', version: sql<number>`version + 1` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', countId)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * Posts a draft count: for each line, what the system holds is locked and
   * recorded as expected, and the difference from what was counted is posted
   * as a `count_adjustment` naming who posted it. Items the count does not
   * list are left alone.
   */
  async postCount(
    countId: string,
    expectedVersion: number,
    meta: { postingId: string; actorId: UserId | string },
  ): Promise<{ count: StockCount; movements: Movement[] } | StockRefusal | 'not_draft'> {
    const count = await this.#lockCount(countId);
    if (count === undefined) {
      return 'not_found';
    }
    if (count.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (count.status !== 'draft') {
      return 'not_draft';
    }
    const lines = await this.countLines(countId);
    const movements: MovementInput[] = [];
    for (const line of lines) {
      const held = await this.lockBalance(line.itemId, count.locationId);
      await this.db
        .updateTable('erp_stock_count_lines')
        .set({ expected_quantity: held })
        .where('tenant_id', '=', this.tenantId)
        .where('count_id', '=', countId)
        .where('item_id', '=', line.itemId)
        .execute();
      const { rows } = await sql<{ variance: string }>`
        select (${line.countedQuantity}::numeric - ${held}::numeric)::text as variance
      `.execute(this.db);
      const variance = rows[0]!.variance;
      if (!/^-?0*(\.0*)?$/u.test(variance)) {
        movements.push({
          itemId: line.itemId,
          locationId: count.locationId,
          kind: 'count_adjustment',
          quantity: variance,
          sourceKey: `count:${countId}:${line.itemId}`,
          stockCountId: countId,
        });
      }
    }
    const posted = await this.post(movements, meta);
    const row = await this.db
      .updateTable('erp_stock_counts')
      .set({
        status: 'posted',
        posted_by: toUserId(meta.actorId),
        posted_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', countId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { count: toCount(row), movements: posted };
  }

  async #lockCount(countId: string): Promise<StockCount | undefined> {
    const row = await this.db
      .selectFrom('erp_stock_counts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', countId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toCount(row);
  }

  /** Adds decimal strings exactly, as `numeric`. */
  async sum(values: readonly string[]): Promise<string> {
    if (values.length === 0) {
      return '0';
    }
    const { rows } = await sql<{ total: string }>`
      select coalesce(sum(v), 0)::text as total from unnest(${sql.val([...values])}::numeric[]) as v
    `.execute(this.db);
    return trimDecimal(rows[0]!.total);
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  /**
   * Replays the company's whole ledger and returns every balance that does
   * not equal the sum of its movements. Empty means the projection is exact.
   */
  async reconcile(): Promise<Discrepancy[]> {
    const { rows } = await sql<{
      item_id: string;
      location_id: string;
      ledger: string;
      balance: string;
    }>`
      select coalesce(m.item_id, b.item_id) as item_id,
             coalesce(m.location_id, b.location_id) as location_id,
             coalesce(m.total, 0)::text as ledger,
             coalesce(b.on_hand, 0)::text as balance
        from (select item_id, location_id, sum(quantity) as total
                from erp_stock_movements
               where tenant_id = ${this.tenantId}
               group by item_id, location_id) m
        full outer join (select item_id, location_id, on_hand
                           from erp_stock_balances
                          where tenant_id = ${this.tenantId}) b
          on b.item_id = m.item_id and b.location_id = m.location_id
       where coalesce(m.total, 0) <> coalesce(b.on_hand, 0)
    `.execute(this.db);
    return rows.map((row) => ({
      itemId: row.item_id,
      locationId: row.location_id,
      ledger: trimDecimal(row.ledger),
      balance: trimDecimal(row.balance),
    }));
  }
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toLocation(row: Selectable<ErpStockLocationsTable>): StockLocation {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    assignedTo: row.assigned_to === null ? null : toUserId(row.assigned_to),
    siteId: row.site_id,
    notes: row.notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toMovement(row: Selectable<ErpStockMovementsTable>): Movement {
  return {
    id: row.id,
    postingId: row.posting_id,
    itemId: row.item_id,
    locationId: row.location_id,
    kind: row.kind,
    quantity: trimDecimal(row.quantity),
    unitCost: row.unit_cost === null ? null : trimDecimal(row.unit_cost),
    sourceKey: row.source_key,
    reason: row.reason,
    stockCountId: row.stock_count_id,
    reversalOf: row.reversal_of,
    actorId: toUserId(row.actor_id),
    occurredAt: row.occurred_at,
  };
}

function toCount(row: Selectable<ErpStockCountsTable>): StockCount {
  return {
    id: row.id,
    locationId: row.location_id,
    status: row.status,
    notes: row.notes,
    version: row.version,
    createdBy: toUserId(row.created_by),
    postedBy: row.posted_by === null ? null : toUserId(row.posted_by),
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
