import { toUserId, type UserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpStockLotsTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Serial numbers and batches (0042; ADR-0013). A lot is created when stock of
 * a tracked item first arrives under its code; it is never changed. What a
 * lot holds where is the ledger's projection (`erp_stock_lot_balances`),
 * written by trigger; this reads it, proposes lots for stock leaving (the
 * earliest expiry first), and traces a serial number's path.
 */

export type LotKind = 'serial' | 'batch';

export interface StockLot {
  id: string;
  itemId: string;
  kind: LotKind;
  code: string;
  /** `YYYY-MM-DD`, for a batch that expires. */
  expiresOn: string | null;
  createdBy: UserId;
  createdAt: Date;
}

export interface LotBalance {
  lotId: string;
  itemId: string;
  locationId: string;
  onHand: string;
}

export interface LotHistoryEntry {
  movementId: string;
  postingId: string;
  locationId: string;
  kind: string;
  quantity: string;
  sourceKey: string;
  reason: string | null;
  actorId: UserId;
  occurredAt: Date;
}

const COLUMNS = [
  'id',
  'item_id',
  'kind',
  'code',
  sql<string | null>`expires_on::text`.as('expires_on'),
  'created_by',
  'created_at',
] as const;

export class InventoryLotsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async find(lotIds: readonly string[]): Promise<StockLot[]> {
    if (lotIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_stock_lots')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(lotIds)])
        .execute()
    ).map(toLot);
  }

  /** An item's lots by code, exactly as written. */
  async byCodes(itemId: string, codes: readonly string[]): Promise<Map<string, StockLot>> {
    if (codes.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('erp_stock_lots')
      .select(COLUMNS)
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .where('code', 'in', [...new Set(codes)])
      .execute();
    return new Map(rows.map((row) => [row.code, toLot(row)]));
  }

  /**
   * The lot with this code, made if the company has not seen it before. A
   * batch arriving again under its code is the same batch; its expiry is kept
   * as first recorded.
   */
  async getOrCreate(
    input: { itemId: string; kind: LotKind; code: string; expiresOn: string | null },
    createdBy: UserId | string,
  ): Promise<StockLot> {
    const code = input.code.trim();
    await this.db
      .insertInto('erp_stock_lots')
      .values({
        tenant_id: this.tenantId,
        item_id: input.itemId,
        kind: input.kind,
        code,
        expires_on: input.kind === 'batch' ? input.expiresOn : null,
        created_by: toUserId(createdBy),
      })
      .onConflict((conflict) => conflict.columns(['tenant_id', 'item_id', 'code']).doNothing())
      .execute();
    return (await this.byCodes(input.itemId, [code])).get(code)!;
  }

  /**
   * What an item's lots hold at a location, in the order stock should leave:
   * the earliest expiry first (none last), then the oldest. Expired batches
   * are included and marked by their date; the caller decides.
   */
  async available(itemId: string, locationId: string): Promise<(StockLot & { onHand: string })[]> {
    const rows = await this.db
      .selectFrom('erp_stock_lot_balances as b')
      .innerJoin('erp_stock_lots as l', (join) =>
        join.onRef('l.tenant_id', '=', 'b.tenant_id').onRef('l.id', '=', 'b.lot_id'),
      )
      .select([
        'l.id',
        'l.item_id',
        'l.kind',
        'l.code',
        sql<string | null>`l.expires_on::text`.as('expires_on'),
        'l.created_by',
        'l.created_at',
        sql<string>`b.on_hand::text`.as('on_hand'),
      ])
      .where('b.tenant_id', '=', this.tenantId)
      .where('b.item_id', '=', itemId)
      .where('b.location_id', '=', locationId)
      .where('b.on_hand', '>', '0')
      .orderBy(sql`l.expires_on nulls last`)
      .orderBy('l.created_at')
      .orderBy('l.code')
      .execute();
    return rows.map((row) => ({ ...toLot(row), onHand: trimDecimal(row.on_hand) }));
  }

  /** A lot's stock at a location, locked until the transaction ends. */
  async lockBalance(lotId: string, locationId: string): Promise<string> {
    const { rows } = await sql<{ held: string }>`
      select erp_stock_lock_lot_balance(${this.tenantId}::uuid, ${lotId}::uuid, ${locationId}::uuid)::text as held
    `.execute(this.db);
    return trimDecimal(rows[0]!.held);
  }

  /** Lot balances by item, location or lot; only where something is held. */
  async balances(query: {
    itemId?: string;
    locationId?: string;
    lotIds?: readonly string[];
  }): Promise<LotBalance[]> {
    let select = this.db
      .selectFrom('erp_stock_lot_balances')
      .select(['lot_id', 'item_id', 'location_id', sql<string>`on_hand::text`.as('on_hand')])
      .where('tenant_id', '=', this.tenantId)
      .where('on_hand', '>', '0');
    if (query.itemId !== undefined) {
      select = select.where('item_id', '=', query.itemId);
    }
    if (query.locationId !== undefined) {
      select = select.where('location_id', '=', query.locationId);
    }
    if (query.lotIds !== undefined) {
      if (query.lotIds.length === 0) {
        return [];
      }
      select = select.where('lot_id', 'in', [...new Set(query.lotIds)]);
    }
    return (await select.limit(5000).execute()).map((row) => ({
      lotId: row.lot_id,
      itemId: row.item_id,
      locationId: row.location_id,
      onHand: trimDecimal(row.on_hand),
    }));
  }

  /** Lots whose code starts with this, across items: the serial lookup. */
  async search(code: string, limit = 20): Promise<StockLot[]> {
    const trimmed = code.trim();
    if (trimmed === '') {
      return [];
    }
    return (
      await this.db
        .selectFrom('erp_stock_lots')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where(
          sql<boolean>`lower(code) like ${`${trimmed.toLowerCase().replace(/[\\%_]/gu, '\\$&')}%`}`,
        )
        .orderBy(sql`lower(code)`)
        .limit(Math.min(Math.max(limit, 1), 100))
        .execute()
    ).map(toLot);
  }

  /** Every movement of a lot, oldest first: where it came from and went. */
  async history(lotId: string): Promise<LotHistoryEntry[]> {
    const rows = await this.db
      .selectFrom('erp_stock_movements')
      .select([
        'id',
        'posting_id',
        'location_id',
        'kind',
        sql<string>`quantity::text`.as('quantity'),
        'source_key',
        'reason',
        'actor_id',
        'occurred_at',
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('lot_id', '=', lotId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      movementId: row.id,
      postingId: row.posting_id,
      locationId: row.location_id,
      kind: row.kind,
      quantity: trimDecimal(row.quantity),
      sourceKey: row.source_key,
      reason: row.reason,
      actorId: toUserId(row.actor_id),
      occurredAt: row.occurred_at,
    }));
  }

  /** The lots each movement of a posting moved, by source key prefix: what a return gives back. */
  async movedBySource(sourceKeyPrefix: string): Promise<{ lotId: string; quantity: string }[]> {
    const rows = await this.db
      .selectFrom('erp_stock_movements')
      .select(['lot_id', sql<string>`sum(quantity)::text`.as('quantity')])
      .where('tenant_id', '=', this.tenantId)
      .where('lot_id', 'is not', null)
      .where(sql<boolean>`source_key like ${`${sourceKeyPrefix.replace(/[\\%_]/gu, '\\$&')}%`}`)
      .groupBy('lot_id')
      .execute();
    return rows.map((row) => ({ lotId: row.lot_id!, quantity: trimDecimal(row.quantity) }));
  }
}

function toLot(
  row: Pick<
    Selectable<ErpStockLotsTable>,
    'id' | 'item_id' | 'kind' | 'code' | 'created_by' | 'created_at'
  > & {
    expires_on: string | null;
  },
): StockLot {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    code: row.code,
    expiresOn: row.expires_on,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
  };
}
