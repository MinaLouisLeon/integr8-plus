import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { AttachmentKind, AttachmentsTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export type AttachmentOwner = { customerId: string } | { siteId: string } | { workOrderId: string };

export interface Attachment {
  id: string;
  fileId: string;
  owner: AttachmentOwner;
  title: string;
  kind: AttachmentKind;
  addedBy: UserId;
  createdAt: Date;
}

function ownerColumn(owner: AttachmentOwner) {
  if ('customerId' in owner) {
    return { column: 'customer_id' as const, id: owner.customerId };
  }
  if ('siteId' in owner) {
    return { column: 'site_id' as const, id: owner.siteId };
  }
  return { column: 'work_order_id' as const, id: owner.workOrderId };
}

/**
 * Files from the ledger shown on a customer, a site or a job: site plans,
 * manuals, previous reports. Removing one takes it off the record; the file
 * itself is deleted through the media routes, which refuse while it is attached.
 */
export class AttachmentsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async add(
    owner: AttachmentOwner,
    input: { fileId: string; title: string; kind?: AttachmentKind },
    addedBy: UserId | string,
  ): Promise<Attachment> {
    const { column, id } = ownerColumn(owner);
    const row = await this.db
      .insertInto('attachments')
      .values({
        tenant_id: this.tenantId,
        file_id: input.fileId,
        [column]: id,
        title: input.title.trim(),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        added_by: toUserId(addedBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAttachment(row);
  }

  async list(owner: AttachmentOwner): Promise<Attachment[]> {
    const { column, id } = ownerColumn(owner);
    return (
      await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where(column, '=', id)
        .where('removed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute()
    ).map(toAttachment);
  }

  async find(attachmentId: string): Promise<Attachment | undefined> {
    const row = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', attachmentId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toAttachment(row);
  }

  async remove(attachmentId: string, by: UserId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('attachments')
      .set({ removed_at: sql<Date>`now()`, removed_by: toUserId(by) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', attachmentId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}

function toAttachment(row: Selectable<AttachmentsTable>): Attachment {
  const owner: AttachmentOwner =
    row.customer_id !== null
      ? { customerId: row.customer_id }
      : row.site_id !== null
        ? { siteId: row.site_id }
        : { workOrderId: row.work_order_id! };
  return {
    id: row.id,
    fileId: row.file_id,
    owner,
    title: row.title,
    kind: row.kind,
    addedBy: toUserId(row.added_by),
    createdAt: row.created_at,
  };
}
