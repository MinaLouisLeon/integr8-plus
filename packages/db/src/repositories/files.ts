import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import {
  type FilesTable,
  type MediaCategory,
  type StorageProvider,
  type ThumbnailStatus,
  type UploadIntentsTable,
  USAGE_CATEGORIES,
  type UsageCategory,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface UploadIntent {
  id: string;
  tenantId: TenantId;
  bucket: string;
  storageKey: string;
  contentType: string;
  declaredBytes: number;
  category: MediaCategory;
  createdBy: UserId;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateUploadIntentInput {
  /** Chosen by the caller, because the storage key is built from it. */
  id: string;
  bucket: string;
  storageKey: string;
  contentType: string;
  declaredBytes: number;
  category: MediaCategory;
  createdBy: UserId | string;
  expiresAt: Date;
}

/** What storage reported when the object was read back. The only source of a ledger row's facts. */
export interface ConfirmedFile {
  byteSize: number;
  etag: string | null;
  contentType: string;
}

export interface FileRecord {
  id: string;
  tenantId: TenantId;
  bucket: string;
  storageKey: string;
  byteSize: number;
  etag: string | null;
  contentType: string;
  category: MediaCategory;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  uploadedBy: UserId;
  createdAt: Date;
  thumbnailStatus: ThumbnailStatus;
  thumbnailKey: string | null;
  thumbnailBytes: number | null;
  deletedAt: Date | null;
  deletedBy: UserId | null;
  purgeAfter: Date | null;
  purgedAt: Date | null;
}

export interface StorageUsage {
  categories: { category: UsageCategory; bytes: number; objects: number }[];
  totalBytes: number;
  totalObjects: number;
}

/**
 * The media ledger for one company, and the uploads on their way into it.
 *
 * An upload starts as an intent — what the client said it would send. It
 * becomes a ledger row only through {@link confirm}, which takes the size, type
 * and ETag storage reported, never the declared ones. Migration 0009 then stops
 * those facts from changing and keeps the usage rollup in step by trigger.
 */
export class FilesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #files() {
    return this.db.selectFrom('files').where('files.tenant_id', '=', this.tenantId);
  }

  #intents() {
    return this.db
      .selectFrom('upload_intents')
      .where('upload_intents.tenant_id', '=', this.tenantId);
  }

  /** This company's bucket, or `undefined` if storage has not been provisioned. */
  async storageLocation(): Promise<
    { provider: StorageProvider; bucket: string; purged: boolean } | undefined
  > {
    const row = await this.db
      .selectFrom('tenant_storage')
      .select(['provider', 'bucket', 'purged_at'])
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { provider: row.provider, bucket: row.bucket, purged: row.purged_at !== null };
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  async createIntent(input: CreateUploadIntentInput): Promise<UploadIntent> {
    const row = await this.db
      .insertInto('upload_intents')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        bucket: input.bucket,
        storage_key: input.storageKey,
        content_type: input.contentType,
        declared_bytes: input.declaredBytes,
        category: input.category,
        created_by: toUserId(input.createdBy),
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toIntent(row);
  }

  async findIntent(intentId: string): Promise<UploadIntent | undefined> {
    const row = await this.#intents().selectAll().where('id', '=', intentId).executeTakeFirst();
    return row === undefined ? undefined : toIntent(row);
  }

  async deleteIntent(intentId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('upload_intents')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', intentId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Intents whose upload window has passed: never confirmed, and their objects are orphans. */
  async listExpiredIntents(now: Date, limit = 500): Promise<UploadIntent[]> {
    return (
      await this.#intents()
        .selectAll()
        .where('expires_at', '<', now)
        .orderBy('expires_at')
        .limit(limit)
        .execute()
    ).map(toIntent);
  }

  /**
   * Turns an intent into a ledger row with what storage reported. The intent is
   * claimed by deleting it, so of two confirmations racing only one writes a
   * row. Returns `undefined` if the intent is gone — confirmed already, or swept.
   */
  async confirm(intentId: string, stored: ConfirmedFile): Promise<FileRecord | undefined> {
    const claimed = await this.db
      .deleteFrom('upload_intents')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', intentId)
      .returningAll()
      .executeTakeFirst();
    if (claimed === undefined) {
      return undefined;
    }
    const intent = toIntent(claimed);
    const row = await this.db
      .insertInto('files')
      .values({
        id: intent.id,
        tenant_id: this.tenantId,
        bucket: intent.bucket,
        storage_key: intent.storageKey,
        byte_size: stored.byteSize,
        etag: stored.etag,
        content_type: stored.contentType,
        category: intent.category,
        uploaded_by: intent.createdBy,
        thumbnail_status: intent.category === 'image' ? 'pending' : 'none',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toFile(row);
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async find(fileId: string): Promise<FileRecord | undefined> {
    const row = await this.#files().selectAll().where('id', '=', fileId).executeTakeFirst();
    return row === undefined ? undefined : toFile(row);
  }

  async findMany(fileIds: readonly string[]): Promise<FileRecord[]> {
    if (fileIds.length === 0) {
      return [];
    }
    return (
      await this.#files()
        .selectAll()
        .where('id', 'in', [...new Set(fileIds)])
        .execute()
    ).map(toFile);
  }

  /** Whether any submission, or any entry in any submission's history, names this file. */
  async isReferenced(fileId: string): Promise<boolean> {
    const found = await this.db
      .selectNoFrom((eb) =>
        eb
          .or([
            eb.exists(
              eb
                .selectFrom('submissions')
                .select(sql`1`.as('one'))
                .where('submissions.tenant_id', '=', this.tenantId)
                .where(sql<boolean>`strpos(submissions.answers::text, ${fileId}) > 0`),
            ),
            eb.exists(
              eb
                .selectFrom('submission_events')
                .select(sql`1`.as('one'))
                .where('submission_events.tenant_id', '=', this.tenantId)
                .where(sql<boolean>`strpos(submission_events.answers::text, ${fileId}) > 0`),
            ),
          ])
          .as('referenced'),
      )
      .executeTakeFirstOrThrow();
    return found.referenced === true;
  }

  /** Starts the restore window. The object stays in storage until it ends. */
  async softDelete(
    fileId: string,
    by: UserId | string,
    purgeAfter: Date,
  ): Promise<FileRecord | undefined> {
    const row = await this.db
      .updateTable('files')
      .set({ deleted_at: sql<Date>`now()`, deleted_by: toUserId(by), purge_after: purgeAfter })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', fileId)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toFile(row);
  }

  /** Undoes a deletion inside its restore window. */
  async restore(fileId: string, now: Date): Promise<FileRecord | undefined> {
    const row = await this.db
      .updateTable('files')
      .set({ deleted_at: null, deleted_by: null, purge_after: null })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', fileId)
      .where('purged_at', 'is', null)
      .where('purge_after', '>', now)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toFile(row);
  }

  async listDueForPurge(now: Date, limit = 500): Promise<FileRecord[]> {
    return (
      await this.#files()
        .selectAll()
        .where('deleted_at', 'is not', null)
        .where('purged_at', 'is', null)
        .where('purge_after', '<=', now)
        .orderBy('purge_after')
        .limit(limit)
        .execute()
    ).map(toFile);
  }

  /** The object is gone from storage. The row stays, as the record that it existed. */
  async markPurged(fileId: string, at: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('files')
      .set({ purged_at: at })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', fileId)
      .where('deleted_at', 'is not', null)
      .where('purged_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async recordThumbnail(
    fileId: string,
    thumbnail: { key: string; bytes: number },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('files')
      .set({
        thumbnail_status: 'ready',
        thumbnail_key: thumbnail.key,
        thumbnail_bytes: thumbnail.bytes,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', fileId)
      .where('thumbnail_status', '=', 'pending')
      .where('purged_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async markThumbnailFailed(fileId: string): Promise<void> {
    await this.db
      .updateTable('files')
      .set({ thumbnail_status: 'failed' })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', fileId)
      .where('thumbnail_status', '=', 'pending')
      .execute();
  }

  /** Bytes and objects in this company's bucket, as the ledger accounts for them. */
  async usage(): Promise<StorageUsage> {
    const rows = await this.db
      .selectFrom('tenant_storage_usage')
      .select(['category', 'bytes', 'objects'])
      .where('tenant_id', '=', this.tenantId)
      .execute();
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    const categories = USAGE_CATEGORIES.map((category) => ({
      category,
      bytes: Number(byCategory.get(category)?.bytes ?? 0),
      objects: byCategory.get(category)?.objects ?? 0,
    }));
    return {
      categories,
      totalBytes: categories.reduce((sum, entry) => sum + entry.bytes, 0),
      totalObjects: categories.reduce((sum, entry) => sum + entry.objects, 0),
    };
  }
}

function toIntent(row: Selectable<UploadIntentsTable>): UploadIntent {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    bucket: row.bucket,
    storageKey: row.storage_key,
    contentType: row.content_type,
    declaredBytes: Number(row.declared_bytes),
    category: row.category,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toFile(row: Selectable<FilesTable>): FileRecord {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    bucket: row.bucket,
    storageKey: row.storage_key,
    byteSize: Number(row.byte_size),
    etag: row.etag,
    contentType: row.content_type,
    category: row.category,
    linkedEntityType: row.linked_entity_type,
    linkedEntityId: row.linked_entity_id,
    uploadedBy: toUserId(row.uploaded_by),
    createdAt: row.created_at,
    thumbnailStatus: row.thumbnail_status,
    thumbnailKey: row.thumbnail_key,
    thumbnailBytes: row.thumbnail_bytes === null ? null : Number(row.thumbnail_bytes),
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by === null ? null : toUserId(row.deleted_by),
    purgeAfter: row.purge_after,
    purgedAt: row.purged_at,
  };
}
