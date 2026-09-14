import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { MediaObjectsTable, MediaStatus } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface MediaObject {
  id: string;
  tenantId: TenantId;
  contentType: string;
  byteSize: number;
  storageKey: string;
  status: MediaStatus;
  createdBy: UserId;
  createdAt: Date;
  storedAt: Date | null;
}

export interface CreateMediaInput {
  contentType: string;
  byteSize: number;
  storageKey: string;
  createdBy: UserId | string;
}

/**
 * The record of every uploaded file.
 *
 * The bytes are not here: they are wherever the API's storage adapter puts them
 * (local disk in development, R2 from P09). This table is what lets the API say
 * a submission's photo was really uploaded, by this company, as the type and
 * size the submission claims.
 */
export class MediaRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #scoped() {
    return this.db.selectFrom('media_objects').where('media_objects.tenant_id', '=', this.tenantId);
  }

  /** Records an upload about to happen. Pending until `markStored`. */
  async create(input: CreateMediaInput): Promise<MediaObject> {
    const row = await this.db
      .insertInto('media_objects')
      .values({
        tenant_id: this.tenantId,
        content_type: input.contentType,
        byte_size: input.byteSize,
        storage_key: input.storageKey,
        created_by: toUserId(input.createdBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async find(mediaId: string): Promise<MediaObject | undefined> {
    const row = await this.#scoped().selectAll().where('id', '=', mediaId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async findMany(mediaIds: readonly string[]): Promise<MediaObject[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const rows = await this.#scoped()
      .selectAll()
      .where('id', 'in', [...new Set(mediaIds)])
      .execute();
    return rows.map(toDomain);
  }

  /** The bytes are confirmed in storage. Only a pending object can become stored. */
  async markStored(mediaId: string): Promise<MediaObject | undefined> {
    const row = await this.db
      .updateTable('media_objects')
      .set({ status: 'stored', stored_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', mediaId)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }
}

function toDomain(row: Selectable<MediaObjectsTable>): MediaObject {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    storageKey: row.storage_key,
    status: row.status,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    storedAt: row.stored_at,
  };
}
