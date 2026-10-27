import {
  type AssetCondition,
  type AssetEventKind,
  type AssetStatus,
  DEFAULT_WARRANTY_ALERT_DAYS,
  normalizeTagCode,
  parseAssetReference,
  toUserId,
  type UserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ErpAssetEventsTable, ErpAssetsTable, MaterialLot } from '../schema.js';
import { type Attachment, toAttachment } from './attachments.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import { prefixQuery } from './customers.js';
import { blankToNull } from './sales-quotes.js';
import { ContractsRepository } from './contracts.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * The machines a company services (CRM/ERP plan, phase E3; ADR-0008).
 *
 * An asset belongs to one customer's site and is numbered by the database
 * when created. It is never deleted, only retired, and every change that
 * matters appends an immutable event (the runtime role may only insert and
 * read events). The timeline is read from the asset's events, the jobs it is
 * linked to, and the submissions, parts and photos attributed to it: those
 * that name it, and those on a job whose only asset it is.
 */

export interface Asset {
  id: string;
  reference: number;
  customerId: string;
  siteId: string;
  itemId: string | null;
  name: string;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  locationNote: string | null;
  /** `YYYY-MM-DD`. */
  installDate: string | null;
  /** `YYYY-MM-DD`. */
  warrantyExpiresOn: string | null;
  status: AssetStatus;
  condition: AssetCondition | null;
  conditionRecordedAt: Date | null;
  conditionRecordedBy: UserId | null;
  tagCode: string;
  notes: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  retiredAt: Date | null;
  retiredBy: UserId | null;
}

/** The fields an edit may change; `undefined` leaves one as it is. */
export interface AssetDetailsInput {
  name?: string | undefined;
  make?: string | null | undefined;
  model?: string | null | undefined;
  serialNumber?: string | null | undefined;
  itemId?: string | null | undefined;
  locationNote?: string | null | undefined;
  installDate?: string | null | undefined;
  warrantyExpiresOn?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface AssetRegistration extends AssetDetailsInput {
  /** Chosen by a phone that registered it offline, so its later changes can name it. */
  id?: string | undefined;
  name: string;
  customerId: string;
  siteId: string;
  tagCode: string;
  condition?: AssetCondition | undefined;
}

export interface AssetEvent {
  id: string;
  assetId: string;
  kind: AssetEventKind;
  fromCustomerId: string | null;
  fromSiteId: string | null;
  fromStatus: AssetStatus | null;
  toStatus: AssetStatus | null;
  condition: AssetCondition | null;
  changes: Record<string, [unknown, unknown]> | null;
  workOrderId: string | null;
  note: string | null;
  actorId: UserId;
  occurredAt: Date;
  recordedAt: Date;
}

/** Where a write came from: the office now, or the phone with its own id and clock. */
export interface AssetWriteContext {
  workOrderId?: string | null | undefined;
  note?: string | null | undefined;
  occurredAt?: Date | undefined;
  clientActionId?: string | undefined;
}

export type AssetWriteRefusal = 'version_conflict' | 'serial_taken';

export interface AssetListQuery {
  text?: string | undefined;
  customerId?: string | undefined;
  siteId?: string | undefined;
  statuses?: readonly AssetStatus[] | undefined;
  /** Assets whose warranty ends on or before this day and is not retired. */
  warrantyEndsBy?: string | undefined;
  /** With `warrantyEndsBy`: leave out those already ended before this day. */
  warrantyEndsFrom?: string | undefined;
  /** Assets at sites where this person has a job (an engineer's scope). */
  visibleTo?: string | undefined;
  /** Reference below which to continue, newest first. */
  before?: number | undefined;
  limit?: number | undefined;
}

export interface AssetLink {
  workOrderId: string;
  assetId: string;
  linkedBy: UserId;
  linkedAt: Date;
}

/** A submission on the timeline. */
export interface AssetSubmission {
  id: string;
  formId: string;
  formVersionId: string;
  workOrderId: string | null;
  /** Named explicitly, or attributed through a job whose only asset this is. */
  explicit: boolean;
  status: string;
  answers: Record<string, unknown>;
  submittedBy: UserId;
  submittedAt: Date;
}

/** A part used on the timeline. */
export interface AssetPart {
  id: string;
  workOrderId: string;
  itemId: string;
  quantity: string;
  returnedQuantity: string;
  explicit: boolean;
  recordedBy: UserId;
  occurredAt: Date;
  /** The serial numbers or batches fitted (0042); null for an untracked item. */
  lots: MaterialLot[] | null;
}

const DETAIL_COLUMNS: Record<keyof AssetDetailsInput, keyof Selectable<ErpAssetsTable>> = {
  name: 'name',
  make: 'make',
  model: 'model',
  serialNumber: 'serial_number',
  itemId: 'item_id',
  locationNote: 'location_note',
  installDate: 'install_date',
  warrantyExpiresOn: 'warranty_expires_on',
  notes: 'notes',
};

const TEXT_FIELDS = new Set<keyof AssetDetailsInput>([
  'name',
  'make',
  'model',
  'serialNumber',
  'locationNote',
  'notes',
]);

function detailValue(field: keyof AssetDetailsInput, value: string | null): string | null {
  return TEXT_FIELDS.has(field) ? blankToNull(value) : value;
}

function isSerialTaken(error: unknown): boolean {
  return (error as { constraint?: string }).constraint === 'erp_assets_serial_unique';
}

export class AssetsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async settings(): Promise<{ warrantyAlertDays: number; version: number }> {
    const row = await this.db
      .selectFrom('erp_asset_settings')
      .select(['warranty_alert_days', 'version'])
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row === undefined
      ? { warrantyAlertDays: DEFAULT_WARRANTY_ALERT_DAYS, version: 0 }
      : { warrantyAlertDays: row.warranty_alert_days, version: row.version };
  }

  /** `expectedVersion` 0 creates the row. */
  async saveSettings(
    expectedVersion: number,
    warrantyAlertDays: number,
    by: UserId | string,
  ): Promise<{ warrantyAlertDays: number; version: number } | 'version_conflict'> {
    if (expectedVersion === 0) {
      const row = await this.db
        .insertInto('erp_asset_settings')
        .values({
          tenant_id: this.tenantId,
          warranty_alert_days: warrantyAlertDays,
          updated_by: toUserId(by),
        })
        .onConflict((conflict) => conflict.column('tenant_id').doNothing())
        .returning(['warranty_alert_days', 'version'])
        .executeTakeFirst();
      return row === undefined
        ? 'version_conflict'
        : { warrantyAlertDays: row.warranty_alert_days, version: row.version };
    }
    const row = await this.db
      .updateTable('erp_asset_settings')
      .set((eb) => ({
        warranty_alert_days: warrantyAlertDays,
        updated_by: toUserId(by),
        version: eb('version', '+', 1),
      }))
      .where('tenant_id', '=', this.tenantId)
      .where('version', '=', expectedVersion)
      .returning(['warranty_alert_days', 'version'])
      .executeTakeFirst();
    return row === undefined
      ? 'version_conflict'
      : { warrantyAlertDays: row.warranty_alert_days, version: row.version };
  }

  // -------------------------------------------------------------------------
  // The register
  // -------------------------------------------------------------------------

  /**
   * Registers an asset with its `registered` event (and a `condition_recorded`
   * one when a condition is given). From the phone, the same `clientActionId`
   * twice returns the asset the first one made.
   */
  async register(
    input: AssetRegistration,
    by: UserId | string,
    context: AssetWriteContext = {},
  ): Promise<{ asset: Asset; created: boolean } | 'serial_taken'> {
    if (context.clientActionId !== undefined) {
      const earlier = await this.db
        .selectFrom('erp_assets')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('client_action_id', '=', context.clientActionId)
        .executeTakeFirst();
      if (earlier !== undefined) {
        return { asset: toAsset(earlier), created: false };
      }
    }
    const actor = toUserId(by);
    const occurredAt = context.occurredAt ?? new Date();
    let row: Selectable<ErpAssetsTable>;
    try {
      row = await this.db
        .insertInto('erp_assets')
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          tenant_id: this.tenantId,
          customer_id: input.customerId,
          site_id: input.siteId,
          item_id: input.itemId ?? null,
          name: input.name.trim(),
          make: blankToNull(input.make),
          model: blankToNull(input.model),
          serial_number: blankToNull(input.serialNumber),
          location_note: blankToNull(input.locationNote),
          install_date: input.installDate ?? null,
          warranty_expires_on: input.warrantyExpiresOn ?? null,
          notes: blankToNull(input.notes),
          tag_code: input.tagCode,
          client_action_id: context.clientActionId ?? null,
          created_by: actor,
          ...(input.condition === undefined
            ? {}
            : {
                condition: input.condition,
                condition_recorded_at: occurredAt,
                condition_recorded_by: actor,
              }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isSerialTaken(error)) {
        return 'serial_taken';
      }
      throw error;
    }
    await this.appendEvent(row.id, 'registered', actor, {
      ...context,
      clientActionId: undefined,
      occurredAt,
    });
    if (input.condition !== undefined) {
      await this.appendEvent(row.id, 'condition_recorded', actor, {
        ...context,
        clientActionId: undefined,
        occurredAt,
        condition: input.condition,
      });
    }
    return { asset: toAsset(row), created: true };
  }

  async find(assetId: string): Promise<Asset | undefined> {
    const row = await this.db
      .selectFrom('erp_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', assetId)
      .executeTakeFirst();
    return row === undefined ? undefined : toAsset(row);
  }

  async findMany(assetIds: readonly string[]): Promise<Asset[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(assetIds)])
      .execute();
    return rows.map(toAsset);
  }

  /** By a tag code as typed or scanned; only this company's assets. */
  async findByTag(code: string): Promise<Asset | undefined> {
    const normalized = normalizeTagCode(code);
    if (normalized === undefined) {
      return undefined;
    }
    const row = await this.db
      .selectFrom('erp_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('tag_code', '=', normalized)
      .executeTakeFirst();
    return row === undefined ? undefined : toAsset(row);
  }

  /** The asset holding this serial, compared trimmed and case-insensitively. */
  async findBySerial(serial: string): Promise<Asset | undefined> {
    const row = await this.db
      .selectFrom('erp_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where(sql<boolean>`lower(btrim(serial_number)) = lower(btrim(${serial}))`)
      .executeTakeFirst();
    return row === undefined ? undefined : toAsset(row);
  }

  async lock(assetId: string): Promise<Asset | undefined> {
    const row = await this.db
      .selectFrom('erp_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', assetId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toAsset(row);
  }

  /** Newest first. Text matches a reference, a tag code, words of the name, make, model, serial or customer. */
  async list(query: AssetListQuery = {}): Promise<{ items: Asset[]; next: number | undefined }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let select = this.db
      .selectFrom('erp_assets')
      .selectAll('erp_assets')
      .where('erp_assets.tenant_id', '=', this.tenantId);
    const text = query.text?.trim() ?? '';
    if (text !== '') {
      const reference = parseAssetReference(text);
      const tag = normalizeTagCode(text);
      const words = prefixQuery(text);
      const like = `%${text.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      select = select.where((eb) =>
        eb.or([
          ...(reference === undefined ? [] : [eb('erp_assets.reference', '=', reference)]),
          ...(tag === undefined ? [] : [eb('erp_assets.tag_code', '=', tag)]),
          eb('erp_assets.name', 'ilike', like),
          eb('erp_assets.make', 'ilike', like),
          eb('erp_assets.model', 'ilike', like),
          eb('erp_assets.serial_number', 'ilike', like),
          eb('erp_assets.location_note', 'ilike', like),
          ...(words === undefined
            ? []
            : [
                eb.exists(
                  eb
                    .selectFrom('customers')
                    .select(sql`1`.as('one'))
                    .where('customers.tenant_id', '=', this.tenantId)
                    .whereRef('customers.id', '=', 'erp_assets.customer_id')
                    .where(sql<boolean>`customers.search @@ to_tsquery('simple', ${words})`),
                ),
              ]),
        ]),
      );
    }
    if (query.customerId !== undefined) {
      select = select.where('erp_assets.customer_id', '=', query.customerId);
    }
    if (query.siteId !== undefined) {
      select = select.where('erp_assets.site_id', '=', query.siteId);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('erp_assets.status', 'in', [...query.statuses]);
    }
    if (query.warrantyEndsBy !== undefined) {
      select = select
        .where('erp_assets.warranty_expires_on', '<=', query.warrantyEndsBy)
        .where('erp_assets.status', '<>', 'retired');
      if (query.warrantyEndsFrom !== undefined) {
        select = select.where('erp_assets.warranty_expires_on', '>=', query.warrantyEndsFrom);
      }
    }
    if (query.visibleTo !== undefined) {
      select = select.where(
        sql<boolean>`erp_assets.site_id in (${this.sitesOfPerson(query.visibleTo)})`,
      );
    }
    if (query.before !== undefined) {
      select = select.where('erp_assets.reference', '<', query.before);
    }
    const rows = await select
      .orderBy('erp_assets.reference', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toAsset);
    return {
      items,
      next: rows.length > limit ? items.at(-1)?.reference : undefined,
    };
  }

  /** Whether this person has a job at the site: an engineer's scope. */
  async personHasSite(userId: string, siteId: string): Promise<boolean> {
    const { rows } = await sql<{ found: boolean }>`
      select exists (${this.sitesOfPerson(userId, siteId)}) as found
    `.execute(this.db);
    return rows[0]?.found === true;
  }

  /** The sites a person is on a job at, as a sub-select. */
  private sitesOfPerson(userId: string, siteId?: string) {
    return sql`select w.site_id from work_orders w
      join work_order_assignments a on a.tenant_id = w.tenant_id and a.work_order_id = w.id
     where w.tenant_id = ${this.tenantId} and a.user_id = ${userId}::uuid
       and a.unassigned_at is null
       ${siteId === undefined ? sql`` : sql`and w.site_id = ${siteId}::uuid`}`;
  }

  /**
   * Changes the details given, appending one `updated` event naming each
   * field that changed, before and after. Nothing changed, nothing written.
   */
  async update(
    assetId: string,
    expectedVersion: number,
    input: AssetDetailsInput,
    by: UserId | string,
    context: AssetWriteContext = {},
  ): Promise<Asset | AssetWriteRefusal> {
    const current = await this.lock(assetId);
    if (current?.version !== expectedVersion) {
      return 'version_conflict';
    }
    const changes: Record<string, [unknown, unknown]> = {};
    const set: Record<string, string | null> = {};
    for (const field of Object.keys(DETAIL_COLUMNS) as (keyof AssetDetailsInput)[]) {
      const given = input[field];
      if (given === undefined) {
        continue;
      }
      const next = detailValue(field, given);
      const before = current[field] ?? null;
      if (next !== before) {
        changes[field] = [before, next];
        set[DETAIL_COLUMNS[field]] = next;
      }
    }
    if (Object.keys(changes).length === 0) {
      return current;
    }
    let row: Selectable<ErpAssetsTable>;
    try {
      row = await this.db
        .updateTable('erp_assets')
        .set((eb) => ({ ...set, version: eb('version', '+', 1) }))
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', assetId)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isSerialTaken(error)) {
        return 'serial_taken';
      }
      throw error;
    }
    await this.appendEvent(assetId, 'updated', toUserId(by), { ...context, changes });
    return toAsset(row);
  }

  /** Moves it to another site (of the same or another customer), with a `relocated` event. */
  async relocate(
    assetId: string,
    expectedVersion: number,
    to: { customerId: string; siteId: string; locationNote?: string | null | undefined },
    by: UserId | string,
    context: AssetWriteContext = {},
  ): Promise<Asset | 'version_conflict' | 'same_site'> {
    const current = await this.lock(assetId);
    if (current?.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.siteId === to.siteId) {
      return 'same_site';
    }
    const row = await this.db
      .updateTable('erp_assets')
      .set((eb) => ({
        customer_id: to.customerId,
        site_id: to.siteId,
        ...(to.locationNote === undefined ? {} : { location_note: blankToNull(to.locationNote) }),
        version: eb('version', '+', 1),
      }))
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', assetId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.appendEvent(assetId, 'relocated', toUserId(by), {
      ...context,
      fromCustomerId: current.customerId,
      fromSiteId: current.siteId,
    });
    return toAsset(row);
  }

  /** Active, out of service, retired; retiring records who and when, reinstating clears it. */
  async setStatus(
    assetId: string,
    expectedVersion: number,
    status: AssetStatus,
    by: UserId | string,
    context: AssetWriteContext = {},
  ): Promise<Asset | 'version_conflict' | 'same_status'> {
    const current = await this.lock(assetId);
    if (current?.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.status === status) {
      return 'same_status';
    }
    const actor = toUserId(by);
    const row = await this.db
      .updateTable('erp_assets')
      .set((eb) => ({
        status,
        retired_at: status === 'retired' ? new Date() : null,
        retired_by: status === 'retired' ? actor : null,
        version: eb('version', '+', 1),
      }))
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', assetId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.appendEvent(assetId, 'status_changed', actor, {
      ...context,
      fromStatus: current.status,
      toStatus: status,
    });
    return toAsset(row);
  }

  /**
   * Records a condition. The asset shows the latest by when it happened, so a
   * phone that syncs late never overwrites a newer reading. The same
   * `clientActionId` twice records it once.
   */
  async recordCondition(
    assetId: string,
    condition: AssetCondition,
    by: UserId | string,
    context: AssetWriteContext = {},
  ): Promise<{ asset: Asset; event: AssetEvent; created: boolean } | undefined> {
    if (context.clientActionId !== undefined) {
      const earlier = await this.db
        .selectFrom('erp_asset_events')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('client_action_id', '=', context.clientActionId)
        .executeTakeFirst();
      if (earlier !== undefined) {
        const asset = await this.find(earlier.asset_id);
        return asset === undefined ? undefined : { asset, event: toEvent(earlier), created: false };
      }
    }
    const current = await this.lock(assetId);
    if (current === undefined) {
      return undefined;
    }
    const actor = toUserId(by);
    const occurredAt = context.occurredAt ?? new Date();
    let asset = current;
    if (current.conditionRecordedAt === null || current.conditionRecordedAt <= occurredAt) {
      const row = await this.db
        .updateTable('erp_assets')
        .set((eb) => ({
          condition,
          condition_recorded_at: occurredAt,
          condition_recorded_by: actor,
          version: eb('version', '+', 1),
        }))
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', assetId)
        .returningAll()
        .executeTakeFirstOrThrow();
      asset = toAsset(row);
    }
    const event = await this.appendEvent(assetId, 'condition_recorded', actor, {
      ...context,
      occurredAt,
      condition,
    });
    return { asset, event, created: true };
  }

  /** A new tag code; the old tag stops opening the asset. */
  async reissueTag(
    assetId: string,
    expectedVersion: number,
    tagCode: string,
    by: UserId | string,
  ): Promise<Asset | 'version_conflict'> {
    const current = await this.lock(assetId);
    if (current?.version !== expectedVersion) {
      return 'version_conflict';
    }
    const row = await this.db
      .updateTable('erp_assets')
      .set((eb) => ({ tag_code: tagCode, version: eb('version', '+', 1) }))
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', assetId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.appendEvent(assetId, 'tag_reissued', toUserId(by), {});
    return toAsset(row);
  }

  private async appendEvent(
    assetId: string,
    kind: AssetEventKind,
    actor: UserId,
    detail: AssetWriteContext & {
      fromCustomerId?: string;
      fromSiteId?: string;
      fromStatus?: AssetStatus;
      toStatus?: AssetStatus;
      condition?: AssetCondition;
      changes?: Record<string, [unknown, unknown]>;
    },
  ): Promise<AssetEvent> {
    const row = await this.db
      .insertInto('erp_asset_events')
      .values({
        tenant_id: this.tenantId,
        asset_id: assetId,
        kind,
        from_customer_id: detail.fromCustomerId ?? null,
        from_site_id: detail.fromSiteId ?? null,
        from_status: detail.fromStatus ?? null,
        to_status: detail.toStatus ?? null,
        condition: detail.condition ?? null,
        changes: detail.changes === undefined ? null : JSON.stringify(detail.changes),
        work_order_id: detail.workOrderId ?? null,
        note: blankToNull(detail.note),
        actor_id: actor,
        occurred_at: detail.occurredAt ?? new Date(),
        client_action_id: detail.clientActionId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEvent(row);
  }

  /** Every event, newest first. */
  async events(assetId: string): Promise<AssetEvent[]> {
    const rows = await this.db
      .selectFrom('erp_asset_events')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('asset_id', '=', assetId)
      .orderBy('occurred_at', 'desc')
      .orderBy('recorded_at', 'desc')
      .execute();
    return rows.map(toEvent);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /** Links an asset to a job; linking twice is harmless. True when it was new. */
  async link(workOrderId: string, assetId: string, by: UserId | string): Promise<boolean> {
    const row = await this.db
      .insertInto('erp_work_order_assets')
      .values({
        tenant_id: this.tenantId,
        work_order_id: workOrderId,
        asset_id: assetId,
        linked_by: toUserId(by),
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'work_order_id', 'asset_id']).doNothing(),
      )
      .returning('asset_id')
      .executeTakeFirst();
    if (row !== undefined) {
      // What a contract covers can depend on the job's assets (P27).
      await new ContractsRepository(this.scope).recalculate(workOrderId);
    }
    return row !== undefined;
  }

  /** True when there was a link to remove. */
  async unlink(workOrderId: string, assetId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('erp_work_order_assets')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('asset_id', '=', assetId)
      .executeTakeFirst();
    if (result.numDeletedRows > 0n) {
      await new ContractsRepository(this.scope).recalculate(workOrderId);
    }
    return result.numDeletedRows > 0n;
  }

  /** The links of these jobs, oldest first. */
  async linksOfWorkOrders(workOrderIds: readonly string[]): Promise<AssetLink[]> {
    if (workOrderIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('erp_work_order_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', 'in', [...new Set(workOrderIds)])
      .orderBy('linked_at')
      .execute();
    return rows.map(toLink);
  }

  /** The jobs this asset is linked to, newest link first. */
  async linksOfAsset(assetId: string): Promise<AssetLink[]> {
    const rows = await this.db
      .selectFrom('erp_work_order_assets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('asset_id', '=', assetId)
      .orderBy('linked_at', 'desc')
      .execute();
    return rows.map(toLink);
  }

  /**
   * The asset a record on this job belongs to when it names none: the job's
   * only asset, or nothing when the job has none or several.
   */
  async soleAssetOf(workOrderId: string): Promise<string | undefined> {
    const rows = await this.db
      .selectFrom('erp_work_order_assets')
      .select('asset_id')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .limit(2)
      .execute();
    return rows.length === 1 ? rows[0]!.asset_id : undefined;
  }

  // -------------------------------------------------------------------------
  // The timeline's records
  // -------------------------------------------------------------------------

  /**
   * Jobs whose only asset this is: what they hold without naming an asset is
   * this asset's.
   */
  private soleJobs(assetId: string) {
    return sql`select l.work_order_id from erp_work_order_assets l
      where l.tenant_id = ${this.tenantId} and l.asset_id = ${assetId}::uuid
        and not exists (select 1 from erp_work_order_assets o
                         where o.tenant_id = l.tenant_id and o.work_order_id = l.work_order_id
                           and o.asset_id <> l.asset_id)`;
  }

  /** Submitted (or reopened) forms for this asset, newest first. Drafts are left out. */
  async submissionsOf(assetId: string): Promise<AssetSubmission[]> {
    const { rows } = await sql<{
      id: string;
      form_id: string;
      form_version_id: string;
      work_order_id: string | null;
      explicit: boolean;
      status: string;
      answers: Record<string, unknown>;
      submitted_by: string;
      submitted_at: Date;
    }>`
      select s.id, s.form_id, s.form_version_id, s.work_order_id,
             (s.asset_id is not null) as explicit, s.status, s.answers,
             s.submitted_by, s.submitted_at
        from submissions s
       where s.tenant_id = ${this.tenantId}
         and s.status <> 'draft'
         and (s.asset_id = ${assetId}::uuid
              or (s.asset_id is null and s.work_order_id in (${this.soleJobs(assetId)})))
       order by s.submitted_at desc, s.id desc
    `.execute(this.db);
    return rows.map((row) => ({
      id: row.id,
      formId: row.form_id,
      formVersionId: row.form_version_id,
      workOrderId: row.work_order_id,
      explicit: row.explicit,
      status: row.status,
      answers: row.answers,
      submittedBy: toUserId(row.submitted_by),
      submittedAt: row.submitted_at,
    }));
  }

  /** The last submission of this form for this asset, for carrying answers over. */
  async lastSubmissionOf(assetId: string, formId: string): Promise<AssetSubmission | undefined> {
    return (await this.submissionsOf(assetId)).find((submission) => submission.formId === formId);
  }

  /** Parts used (not cancelled) for this asset, newest first. */
  async partsOf(assetId: string): Promise<AssetPart[]> {
    const { rows } = await sql<{
      id: string;
      work_order_id: string;
      item_id: string;
      quantity: string;
      returned_quantity: string;
      explicit: boolean;
      recorded_by: string;
      occurred_at: Date;
      lots: MaterialLot[] | null;
    }>`
      select m.id, m.work_order_id, m.item_id, m.quantity::text as quantity,
             m.returned_quantity::text as returned_quantity, (m.asset_id is not null) as explicit,
             m.recorded_by, m.occurred_at, m.lots
        from erp_work_order_materials m
       where m.tenant_id = ${this.tenantId}
         and m.status = 'posted'
         and (m.asset_id = ${assetId}::uuid
              or (m.asset_id is null and m.work_order_id in (${this.soleJobs(assetId)})))
       order by m.occurred_at desc, m.id desc
    `.execute(this.db);
    return rows.map((row) => ({
      id: row.id,
      workOrderId: row.work_order_id,
      itemId: row.item_id,
      quantity: trimDecimal(row.quantity),
      returnedQuantity: trimDecimal(row.returned_quantity),
      explicit: row.explicit,
      recordedBy: toUserId(row.recorded_by),
      occurredAt: row.occurred_at,
      lots: row.lots,
    }));
  }

  /** Files on the asset itself and on the jobs whose only asset it is, newest first. */
  async attachmentsOf(assetId: string): Promise<Attachment[]> {
    const rows = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('removed_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('asset_id', '=', assetId),
          eb('work_order_id', 'in', sql<string>`(${this.soleJobs(assetId)})`),
        ]),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toAttachment);
  }
}

function toAsset(row: Selectable<ErpAssetsTable>): Asset {
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    siteId: row.site_id,
    itemId: row.item_id,
    name: row.name,
    make: row.make,
    model: row.model,
    serialNumber: row.serial_number,
    locationNote: row.location_note,
    installDate: toDayString(row.install_date),
    warrantyExpiresOn: toDayString(row.warranty_expires_on),
    status: row.status,
    condition: row.condition,
    conditionRecordedAt: row.condition_recorded_at,
    conditionRecordedBy:
      row.condition_recorded_by === null ? null : toUserId(row.condition_recorded_by),
    tagCode: row.tag_code,
    notes: row.notes,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
    retiredBy: row.retired_by === null ? null : toUserId(row.retired_by),
  };
}

function toEvent(row: Selectable<ErpAssetEventsTable>): AssetEvent {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    fromCustomerId: row.from_customer_id,
    fromSiteId: row.from_site_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    condition: row.condition,
    changes: row.changes,
    workOrderId: row.work_order_id,
    note: row.note,
    actorId: toUserId(row.actor_id),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function toLink(row: {
  work_order_id: string;
  asset_id: string;
  linked_by: string;
  linked_at: Date;
}): AssetLink {
  return {
    workOrderId: row.work_order_id,
    assetId: row.asset_id,
    linkedBy: toUserId(row.linked_by),
    linkedAt: row.linked_at,
  };
}
