import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ImportKind, ImportRowError, ImportsTable, ImportStatus } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface ImportRecord {
  id: string;
  kind: ImportKind;
  status: ImportStatus;
  fileName: string;
  totalRows: number;
  succeededRows: number;
  failedRows: number;
  errors: ImportRowError[];
  createdBy: UserId;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** At most this many row errors are kept; the counts stay exact beyond it. */
export const MAX_RECORDED_IMPORT_ERRORS = 5000;

/**
 * CSV imports and their outcome. The rows themselves are written through the
 * customer, site and work order repositories, one at a time, by the worker.
 */
export class ImportsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(
    input: { kind: ImportKind; fileName: string; source: string },
    createdBy: UserId | string,
  ): Promise<ImportRecord> {
    const row = await this.db
      .insertInto('imports')
      .values({
        tenant_id: this.tenantId,
        kind: input.kind,
        file_name: input.fileName,
        source: input.source,
        created_by: toUserId(createdBy),
        errors: sql<ImportRowError[]>`'[]'::jsonb`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toImport(row);
  }

  async find(importId: string): Promise<ImportRecord | undefined> {
    const row = await this.db
      .selectFrom('imports')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', importId)
      .executeTakeFirst();
    return row === undefined ? undefined : toImport(row);
  }

  /** The CSV itself, for the worker. Kept out of `find` so a status poll does not carry megabytes. */
  async source(importId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('imports')
      .select('source')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', importId)
      .executeTakeFirst();
    return row?.source;
  }

  async list(limit = 50): Promise<ImportRecord[]> {
    return (
      await this.db
        .selectFrom('imports')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toImport);
  }

  /** Claims a pending import for processing. False if another worker already has. */
  async start(importId: string, totalRows: number): Promise<boolean> {
    const result = await this.db
      .updateTable('imports')
      .set({ status: 'running', started_at: sql<Date>`now()`, total_rows: totalRows })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', importId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Adds a batch of outcomes. Called as the worker goes, so progress can be shown. */
  async recordProgress(
    importId: string,
    batch: { succeeded: number; failed: number; errors: readonly ImportRowError[] },
  ): Promise<void> {
    await this.db
      .updateTable('imports')
      .set({
        succeeded_rows: sql<number>`succeeded_rows + ${batch.succeeded}`,
        failed_rows: sql<number>`failed_rows + ${batch.failed}`,
        errors: sql<
          ImportRowError[]
        >`case when jsonb_array_length(errors) >= ${MAX_RECORDED_IMPORT_ERRORS} then errors else errors || ${JSON.stringify(batch.errors)}::jsonb end`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', importId)
      .execute();
  }

  async finish(
    importId: string,
    status: 'completed' | 'failed',
    errors?: readonly ImportRowError[],
  ) {
    await this.db
      .updateTable('imports')
      .set({
        status,
        completed_at: sql<Date>`now()`,
        ...(errors === undefined
          ? {}
          : { errors: sql<ImportRowError[]>`errors || ${JSON.stringify(errors)}::jsonb` }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', importId)
      .execute();
  }
}

function toImport(row: Selectable<ImportsTable>): ImportRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    fileName: row.file_name,
    totalRows: row.total_rows,
    succeededRows: row.succeeded_rows,
    failedRows: row.failed_rows,
    errors: row.errors,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
