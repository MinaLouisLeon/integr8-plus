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
import { type AttachmentOwner, toAttachment } from './attachments.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/** What a PDF template's images are linked to; retention leaves these alone. */
export const TEMPLATE_ASSET_ENTITY = 'document_template';
/** What a generated PDF is linked to. */
export const DOCUMENT_FILE_ENTITY = 'document';

/**
 * A record that uses a file, and so decides who may read it (docs/media):
 * whoever may see the record. A file nothing uses yet is its uploader's.
 */
export type FileUse =
  /** Named in a submission's answers, now or in its history (0068). */
  | { kind: 'submission'; submissionId: string }
  /** On a customer, site, job, asset, claim, item, purchase or certificate. */
  | { kind: 'attachment'; attachmentId: string; owner: AttachmentOwner }
  /** The customer's signature on a job's sign-off. */
  | { kind: 'signoff'; workOrderId: string }
  /** A document's PDF, generated or uploaded. */
  | { kind: 'document'; documentId: string }
  /** A picture in a PDF template. */
  | { kind: 'document_template'; templateId: string }
  /** The company's logo or app icon. */
  | { kind: 'branding' };

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
  /** Set when the bytes arrive in parts (P12). */
  multipart: { uploadId: string; partSize: number } | null;
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
  multipart?: { uploadId: string; partSize: number };
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
        multipart_upload_id: input.multipart?.uploadId ?? null,
        part_size: input.multipart?.partSize ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toIntent(row);
  }

  /** Keeps an unconfirmed upload alive for longer: a phone resuming it days later. */
  async renewIntent(intentId: string, expiresAt: Date): Promise<UploadIntent | undefined> {
    const row = await this.db
      .updateTable('upload_intents')
      .set({ expires_at: expiresAt })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', intentId)
      .where('expires_at', '<', expiresAt)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? this.findIntent(intentId) : toIntent(row);
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

  /**
   * Records an object the server wrote itself, such as a generated PDF
   * (documents ADR-0001 D5). The facts are what storage reported after the
   * put, as with {@link confirm}; there is no intent, because no client asked
   * to upload anything.
   */
  async recordGenerated(input: {
    id: string;
    bucket: string;
    storageKey: string;
    stored: ConfirmedFile;
    category: MediaCategory;
    uploadedBy: UserId | string;
    linkedEntity: { type: string; id: string };
  }): Promise<FileRecord> {
    const row = await this.db
      .insertInto('files')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        bucket: input.bucket,
        storage_key: input.storageKey,
        byte_size: input.stored.byteSize,
        etag: input.stored.etag,
        content_type: input.stored.contentType,
        category: input.category,
        uploaded_by: toUserId(input.uploadedBy),
        linked_entity_type: input.linkedEntity.type,
        linked_entity_id: input.linkedEntity.id,
        thumbnail_status: 'none',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toFile(row);
  }

  /**
   * Ties an uploaded file to the record that uses it, such as a PDF
   * template's background. Only a file not yet tied to anything else.
   */
  async link(fileId: string, entity: { type: string; id: string }): Promise<boolean> {
    const result = await this.db
      .updateTable('files')
      .set({ linked_entity_type: entity.type, linked_entity_id: entity.id })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', fileId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('linked_entity_type', 'is', null),
          eb.and([
            eb('linked_entity_type', '=', entity.type),
            eb('linked_entity_id', '=', entity.id),
          ]),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
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

  /**
   * Whether any submission, or any entry in any submission's history, names
   * this file, or it is attached to anything. Read from the file-use index
   * (0068), which the database keeps from every save of a submission.
   */
  async isReferenced(fileId: string): Promise<boolean> {
    const found = await this.db
      .selectNoFrom((eb) =>
        eb
          .or([
            eb.exists(
              eb
                .selectFrom('submission_file_uses')
                .select(sql`1`.as('one'))
                .where('submission_file_uses.tenant_id', '=', this.tenantId)
                .where('submission_file_uses.file_id', '=', fileId),
            ),
            eb.exists(
              eb
                .selectFrom('attachments')
                .select(sql`1`.as('one'))
                .where('attachments.tenant_id', '=', this.tenantId)
                .where('attachments.file_id', '=', fileId)
                .where('attachments.removed_at', 'is', null),
            ),
          ])
          .as('referenced'),
      )
      .executeTakeFirstOrThrow();
    return found.referenced === true;
  }

  /** The submissions that name this file, in their answers now or in their history. */
  async submissionsNaming(fileId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('submission_file_uses')
      .select('submission_id')
      .distinct()
      .where('tenant_id', '=', this.tenantId)
      .where('file_id', '=', fileId)
      .orderBy('submission_id')
      .limit(100)
      .execute();
    return rows.map((row) => row.submission_id);
  }

  /**
   * Every record that uses this file (docs/media): what decides who may read
   * it. Empty for a file nothing uses yet. Removed attachments no longer count.
   */
  async uses(
    file: Pick<FileRecord, 'id' | 'linkedEntityType' | 'linkedEntityId'>,
  ): Promise<FileUse[]> {
    const uses: FileUse[] = [];
    if (file.linkedEntityType === TEMPLATE_ASSET_ENTITY && file.linkedEntityId !== null) {
      uses.push({ kind: 'document_template', templateId: file.linkedEntityId });
    }
    const [documents, attachments, signoffs, branding, submissions] = await Promise.all([
      this.db
        .selectFrom('documents')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where((eb) =>
          eb.or([
            eb('file_id', '=', file.id),
            ...(file.linkedEntityType === DOCUMENT_FILE_ENTITY && file.linkedEntityId !== null
              ? [eb('id', '=', file.linkedEntityId)]
              : []),
          ]),
        )
        .execute(),
      this.db
        .selectFrom('attachments')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('file_id', '=', file.id)
        .where('removed_at', 'is', null)
        .orderBy('created_at')
        .limit(100)
        .execute(),
      this.db
        .selectFrom('work_orders')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('signoff_file_id', '=', file.id)
        .execute(),
      this.db
        .selectFrom('tenant_settings')
        .select(sql`1`.as('one'))
        .where('tenant_id', '=', this.tenantId)
        .where((eb) =>
          eb.or([eb('logo_media_id', '=', file.id), eb('app_icon_media_id', '=', file.id)]),
        )
        .execute(),
      this.submissionsNaming(file.id),
    ]);
    uses.push(...documents.map((row) => ({ kind: 'document' as const, documentId: row.id })));
    uses.push(
      ...attachments.map((row) => {
        const attachment = toAttachment(row);
        return {
          kind: 'attachment' as const,
          attachmentId: attachment.id,
          owner: attachment.owner,
        };
      }),
    );
    uses.push(...signoffs.map((row) => ({ kind: 'signoff' as const, workOrderId: row.id })));
    if (branding.length > 0) {
      uses.push({ kind: 'branding' });
    }
    uses.push(
      ...submissions.map((submissionId) => ({ kind: 'submission' as const, submissionId })),
    );
    return uses;
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

  /**
   * Soft-deletes everything uploaded before a date, for a plan's retention
   * window (P16).
   *
   * The same door a person's delete uses, so retention adds no second way for
   * bytes to leave: these land in the restore window and the existing sweep
   * removes them at the end of it.
   *
   * `deleted_by` is null, which the column allows, because nobody deleted
   * these — a policy did. A name in that column would be a lie told to whoever
   * reads the row asking who to talk to.
   *
   * Returns how many it took, and takes at most `limit` in one pass so a
   * company with a decade of history does not become one enormous statement.
   */
  async retireOlderThan(
    before: Date,
    options: { purgeAfter: Date; limit?: number },
  ): Promise<number> {
    const result = await this.db
      .updateTable('files')
      .set({ deleted_at: sql<Date>`now()`, purge_after: options.purgeAfter })
      .where('tenant_id', '=', this.tenantId)
      .where('deleted_at', 'is', null)
      .where('purged_at', 'is', null)
      .where('created_at', '<', before)
      // A PDF template's images are part of the template, not of any one
      // submission: retiring them would break every later document
      // (documents ADR-0001 D5).
      .where((eb) =>
        eb.or([
          eb('linked_entity_type', 'is', null),
          eb('linked_entity_type', '!=', TEMPLATE_ASSET_ENTITY),
        ]),
      )
      .where('id', 'in', (select) =>
        select
          .selectFrom('files')
          .select('id')
          .where('tenant_id', '=', this.tenantId)
          .where('deleted_at', 'is', null)
          .where('purged_at', 'is', null)
          .where('created_at', '<', before)
          .where((eb) =>
            eb.or([
              eb('linked_entity_type', 'is', null),
              eb('linked_entity_type', '!=', TEMPLATE_ASSET_ENTITY),
            ]),
          )
          // The company's logo and app icon are its identity, not a record that
          // ages out: every screen, document and phone build draws them.
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('tenant_settings')
                  .select(sql`1`.as('one'))
                  .where('tenant_settings.tenant_id', '=', this.tenantId)
                  .where((settings) =>
                    settings.or([
                      settings('tenant_settings.logo_media_id', '=', settings.ref('files.id')),
                      settings('tenant_settings.app_icon_media_id', '=', settings.ref('files.id')),
                    ]),
                  ),
              ),
            ),
          )
          .orderBy('created_at')
          .limit(options.limit ?? 500),
      )
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0n);
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
    multipart:
      row.multipart_upload_id === null || row.part_size === null
        ? null
        : { uploadId: row.multipart_upload_id, partSize: row.part_size },
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
