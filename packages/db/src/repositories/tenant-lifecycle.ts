import type { PlatformUserId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type {
  Database,
  TenantDeletionsTable,
  TenantExportsTable,
  TenantExportStatus,
} from '../schema.js';

/**
 * Taking a company's data out, and taking a company out.
 *
 * Deletion is deliberately slow: an export is taken first, the purge is
 * scheduled with a cooling-off period, and cancelling before it runs undoes
 * everything. Neither table has a foreign key to `tenants`, because the record
 * that a company was exported and purged has to outlive the company.
 *
 * The purge itself is `purge_tenant()` in the database (0015), which refuses
 * unless a deletion is scheduled and due — so even the schema owner cannot
 * remove a company by calling it early.
 */

export interface TenantExport {
  id: string;
  tenantId: string;
  tenantSlug: string;
  requestedBy: PlatformUserId | null;
  status: TenantExportStatus;
  objectKey: string | null;
  byteSize: number | null;
  /** How many rows of each kind the export holds, for the screen to show. */
  contents: Record<string, number>;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
}

export interface TenantDeletion {
  id: string;
  tenantId: string;
  tenantSlug: string;
  exportId: string;
  requestedBy: PlatformUserId | null;
  reason: string;
  purgeAfter: Date;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelledBy: PlatformUserId | null;
  completedAt: Date | null;
}

export class TenantLifecycleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  async startExport(input: {
    tenantId: string;
    tenantSlug: string;
    requestedBy: PlatformUserId | string | null;
  }): Promise<TenantExport> {
    const row = await this.db
      .insertInto('tenant_exports')
      .values({
        tenant_id: input.tenantId,
        tenant_slug: input.tenantSlug,
        requested_by: input.requestedBy ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toExport(row);
  }

  async markExportRunning(id: string): Promise<void> {
    await this.db
      .updateTable('tenant_exports')
      .set({ status: 'running' })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .execute();
  }

  async completeExport(input: {
    id: string;
    objectKey: string;
    byteSize: number;
    contents: Record<string, number>;
    expiresAt: Date;
    now?: Date;
  }): Promise<TenantExport> {
    const row = await this.db
      .updateTable('tenant_exports')
      .set({
        status: 'ready',
        object_key: input.objectKey,
        byte_size: String(input.byteSize),
        contents: JSON.stringify(input.contents) as never,
        completed_at: input.now ?? new Date(),
        expires_at: input.expiresAt,
        error: null,
      })
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toExport(row);
  }

  async failExport(id: string, error: string, now = new Date()): Promise<void> {
    await this.db
      .updateTable('tenant_exports')
      .set({ status: 'failed', error: error.slice(0, 2_000), completed_at: now })
      .where('id', '=', id)
      .execute();
  }

  async findExport(id: string): Promise<TenantExport | undefined> {
    const row = await this.db
      .selectFrom('tenant_exports')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toExport(row);
  }

  async listExports(tenantId: string, limit = 20): Promise<TenantExport[]> {
    return (
      await this.db
        .selectFrom('tenant_exports')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toExport);
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /** Schedules a purge. The unique index refuses a second live schedule for one company. */
  async schedule(input: {
    tenantId: string;
    tenantSlug: string;
    exportId: string;
    requestedBy: PlatformUserId | string | null;
    reason: string;
    purgeAfter: Date;
  }): Promise<TenantDeletion> {
    const row = await this.db
      .insertInto('tenant_deletions')
      .values({
        tenant_id: input.tenantId,
        tenant_slug: input.tenantSlug,
        export_id: input.exportId,
        requested_by: input.requestedBy ?? null,
        reason: input.reason.trim(),
        purge_after: input.purgeAfter,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDeletion(row);
  }

  async pendingFor(tenantId: string): Promise<TenantDeletion | undefined> {
    const row = await this.db
      .selectFrom('tenant_deletions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('cancelled_at', 'is', null)
      .where('completed_at', 'is', null)
      .executeTakeFirst();

    return row === undefined ? undefined : toDeletion(row);
  }

  async cancel(input: {
    tenantId: string;
    cancelledBy: PlatformUserId | string | null;
    now?: Date;
  }): Promise<TenantDeletion | undefined> {
    const row = await this.db
      .updateTable('tenant_deletions')
      .set({ cancelled_at: input.now ?? new Date(), cancelled_by: input.cancelledBy ?? null })
      .where('tenant_id', '=', input.tenantId)
      .where('cancelled_at', 'is', null)
      .where('completed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDeletion(row);
  }

  /**
   * Moves a scheduled purge, without changing anything else about it.
   *
   * The cooling-off period is a default, not a law: a customer who insists
   * their data goes today is entitled to that, and a company somebody wants
   * another fortnight to think about should not have to be cancelled and
   * scheduled again. What it cannot do is skip the guard — `purge_tenant()`
   * still refuses anything not yet due — so bringing a purge forward is a
   * deliberate act with its own audit entry rather than a way around the delay.
   */
  async reschedule(tenantId: string, purgeAfter: Date): Promise<TenantDeletion | undefined> {
    const row = await this.db
      .updateTable('tenant_deletions')
      .set({ purge_after: purgeAfter })
      .where('tenant_id', '=', tenantId)
      .where('cancelled_at', 'is', null)
      .where('completed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDeletion(row);
  }

  /** Every schedule whose cooling-off has passed: what the purge job works through. */
  async due(now = new Date()): Promise<TenantDeletion[]> {
    return (
      await this.db
        .selectFrom('tenant_deletions')
        .selectAll()
        .where('cancelled_at', 'is', null)
        .where('completed_at', 'is', null)
        .where('purge_after', '<=', now)
        .orderBy('purge_after', 'asc')
        .execute()
    ).map(toDeletion);
  }

  async listDeletions(limit = 50): Promise<TenantDeletion[]> {
    return (
      await this.db
        .selectFrom('tenant_deletions')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toDeletion);
  }

  /**
   * Deletes every row of one company. The database refuses unless a deletion is
   * scheduled and due, so this cannot be the whole of a mistake.
   */
  async purge(tenantId: string): Promise<void> {
    await sql`select purge_tenant(${tenantId}::uuid)`.execute(this.db);
  }
}

function toExport(row: Selectable<TenantExportsTable>): TenantExport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    requestedBy: row.requested_by as PlatformUserId | null,
    status: row.status,
    objectKey: row.object_key,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    contents: row.contents as unknown as Record<string, number>,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

function toDeletion(row: Selectable<TenantDeletionsTable>): TenantDeletion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    exportId: row.export_id,
    requestedBy: row.requested_by as PlatformUserId | null,
    reason: row.reason,
    purgeAfter: row.purge_after,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by as PlatformUserId | null,
    completedAt: row.completed_at,
  };
}
