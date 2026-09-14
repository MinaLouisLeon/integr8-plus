import { type TenantId, toTenantId } from '@integr8/core';
import { type Kysely, sql } from 'kysely';
import type { Database, StorageProvider } from '../schema.js';

export interface TenantBucket {
  tenantId: TenantId;
  provider: StorageProvider;
  bucket: string;
  provisionedAt: Date;
  purgedAt: Date | null;
}

/**
 * Which bucket each company has, and the platform's side of removing a
 * company's media.
 *
 * On the owner connection: provisioning happens as a company is created, before
 * any request of its own, and purging removes ledger rows the runtime role is
 * not allowed to delete.
 */
export class StorageRegistry {
  constructor(private readonly db: Kysely<Database>) {}

  async find(tenantId: string): Promise<TenantBucket | undefined> {
    const row = await this.db
      .selectFrom('tenant_storage')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : toBucket(row);
  }

  /** Records a provisioned bucket. Idempotent: provisioning twice returns the first record. */
  async record(input: {
    tenantId: string;
    provider: StorageProvider;
    bucket: string;
  }): Promise<TenantBucket> {
    await this.db
      .insertInto('tenant_storage')
      .values({ tenant_id: input.tenantId, provider: input.provider, bucket: input.bucket })
      .onConflict((conflict) => conflict.column('tenant_id').doNothing())
      .execute();
    return (await this.find(input.tenantId))!;
  }

  /** Every company with a bucket that has not been purged, for maintenance to visit. */
  async listActive(): Promise<TenantBucket[]> {
    const rows = await this.db
      .selectFrom('tenant_storage')
      .selectAll()
      .where('purged_at', 'is', null)
      .orderBy('provisioned_at')
      .execute();
    return rows.map(toBucket);
  }

  /**
   * Removes a company's media records, after its objects and bucket are gone.
   *
   * Ledger rows first, so the usage trigger winds the rollup down to zero, then
   * the rollup and any intents, then the bucket record is marked purged — kept,
   * so the fact that a bucket existed and was emptied is not lost with it.
   */
  async purgeRecords(tenantId: string): Promise<{ files: number; intents: number }> {
    return this.db.transaction().execute(async (trx) => {
      const files = await trx
        .deleteFrom('files')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      const intents = await trx
        .deleteFrom('upload_intents')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      await trx.deleteFrom('tenant_storage_usage').where('tenant_id', '=', tenantId).execute();
      await trx
        .updateTable('tenant_storage')
        .set({ purged_at: sql<Date>`now()` })
        .where('tenant_id', '=', tenantId)
        .execute();
      return { files: Number(files.numDeletedRows), intents: Number(intents.numDeletedRows) };
    });
  }
}

function toBucket(row: {
  tenant_id: string;
  provider: StorageProvider;
  bucket: string;
  provisioned_at: Date;
  purged_at: Date | null;
}): TenantBucket {
  return {
    tenantId: toTenantId(row.tenant_id),
    provider: row.provider,
    bucket: row.bucket,
    provisionedAt: row.provisioned_at,
    purgedAt: row.purged_at,
  };
}
