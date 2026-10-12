import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { AttachmentKind, AttachmentsTable, PhotoStage } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export type AttachmentOwner =
  | { customerId: string }
  | { siteId: string }
  | { workOrderId: string }
  /** A machine on the asset register (0031). */
  | { assetId: string }
  /** A receipt for a staff expense claim (0037). */
  | { expenseClaimId: string }
  /** An item's image or datasheet (0040). */
  | { itemId: string }
  /** A receipt for a part bought from a merchant for a job (0040). */
  | { workOrderPurchaseId: string };

export interface Attachment {
  id: string;
  fileId: string;
  owner: AttachmentOwner;
  title: string;
  kind: AttachmentKind;
  /** For a job photo: taken before or after the work (P14). */
  stage: PhotoStage | null;
  /** An item's main image, the one the phone keeps (0040). */
  isMain: boolean;
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
  if ('assetId' in owner) {
    return { column: 'asset_id' as const, id: owner.assetId };
  }
  if ('expenseClaimId' in owner) {
    return { column: 'expense_claim_id' as const, id: owner.expenseClaimId };
  }
  if ('itemId' in owner) {
    return { column: 'item_id' as const, id: owner.itemId };
  }
  if ('workOrderPurchaseId' in owner) {
    return { column: 'work_order_purchase_id' as const, id: owner.workOrderPurchaseId };
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
    input: {
      /** Chosen by a phone that took the photo offline, so a resend finds it. */
      id?: string;
      fileId: string;
      title: string;
      kind?: AttachmentKind;
      stage?: PhotoStage;
    },
    addedBy: UserId | string,
  ): Promise<Attachment> {
    const { column, id } = ownerColumn(owner);
    const row = await this.db
      .insertInto('attachments')
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
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

  /** Found whether or not it has been removed: what a resent change needs to know. */
  async findAny(attachmentId: string): Promise<(Attachment & { removed: boolean }) | undefined> {
    const row = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', attachmentId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { ...toAttachment(row), removed: row.removed_at !== null };
  }

  /**
   * Makes this image its item's main one, and no other (ADR-0012). False
   * when it is not a current attachment of an item.
   */
  async setMain(attachmentId: string): Promise<boolean> {
    const target = await this.find(attachmentId);
    if (target === undefined || !('itemId' in target.owner)) {
      return false;
    }
    await this.db
      .updateTable('attachments')
      .set({ is_main: false })
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', target.owner.itemId)
      .where('is_main', '=', true)
      .execute();
    await this.db
      .updateTable('attachments')
      .set({ is_main: true })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', attachmentId)
      .execute();
    return true;
  }

  /** Each of these items' main image: item id to file id. */
  async mainImages(itemIds: readonly string[]): Promise<Map<string, string>> {
    if (itemIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('attachments')
      .select(['item_id', 'file_id'])
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', 'in', [...new Set(itemIds)])
      .where('is_main', '=', true)
      .where('removed_at', 'is', null)
      .execute();
    return new Map(rows.map((row) => [row.item_id!, row.file_id]));
  }

  async remove(attachmentId: string, by: UserId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('attachments')
      .set({ removed_at: sql<Date>`now()`, removed_by: toUserId(by), is_main: false })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', attachmentId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}

export function toAttachment(row: Selectable<AttachmentsTable>): Attachment {
  const owner: AttachmentOwner =
    row.customer_id !== null
      ? { customerId: row.customer_id }
      : row.site_id !== null
        ? { siteId: row.site_id }
        : row.asset_id !== null
          ? { assetId: row.asset_id }
          : row.expense_claim_id !== null
            ? { expenseClaimId: row.expense_claim_id }
            : row.item_id !== null
              ? { itemId: row.item_id }
              : row.work_order_purchase_id !== null
                ? { workOrderPurchaseId: row.work_order_purchase_id }
                : { workOrderId: row.work_order_id! };
  return {
    id: row.id,
    fileId: row.file_id,
    owner,
    title: row.title,
    kind: row.kind,
    stage: row.stage,
    isMain: row.is_main,
    addedBy: toUserId(row.added_by),
    createdAt: row.created_at,
  };
}
