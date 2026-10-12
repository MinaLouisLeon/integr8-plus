import { type Attachment, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { requireAttachable } from './customers.js';
import { FEATURE, TAGS } from './inventory.js';
import { attachmentBodies, attachmentSchema, peopleOf } from './operations.js';

/**
 * An item's images and datasheets (eighth round; ADR-0012), from the media
 * storage everything else uses. Everyone who sees the item sees them; those
 * who manage the catalogue add and remove them. One image is the main one:
 * the phone keeps it for offline use, while datasheets open online.
 */

const itemMediaSchema = attachmentSchema.extend({
  /** The item's main image. */
  isMain: z.boolean(),
});

const itemParams = z.object({ itemId: z.uuid() });

const isImage = (contentType: string) => contentType.startsWith('image/');

async function requireItem(tx: TenantTransaction, itemId: string) {
  const item = await tx.inventoryCatalogue.findItem(itemId);
  if (item === undefined) {
    throw notFound('This item does not exist.');
  }
  return item;
}

async function mediaBodies(tx: TenantTransaction, attachments: Attachment[]) {
  const main = new Map(attachments.map((attachment) => [attachment.id, attachment.isMain]));
  return (await attachmentBodies(tx, attachments, await peopleOf(tx))).map((body) => ({
    ...body,
    isMain: main.get(body.id) ?? false,
  }));
}

/** Images first, the main one leading; then datasheets, newest first. */
async function itemMedia(tx: TenantTransaction, itemId: string) {
  const bodies = await mediaBodies(tx, await tx.attachments.list({ itemId }));
  return bodies.sort(
    (a, b) =>
      Number(b.isMain) - Number(a.isMain) ||
      Number(isImage(b.contentType)) - Number(isImage(a.contentType)),
  );
}

export const listItemMediaRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/items/:itemId/media',
  operationId: 'listItemMedia',
  summary: 'An item’s images and datasheets',
  description: 'Images first, the main one leading; then datasheets and other files.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: FEATURE,
  params: itemParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The files.', schema: z.object({ items: z.array(itemMediaSchema) }) },
    404: { description: 'No such item.' },
  },
  handler: async ({ params }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      await requireItem(tx, params.itemId);
      return itemMedia(tx, params.itemId);
    });
    return { status: 200, body: { items } };
  },
});

export const addItemMediaRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/items/:itemId/media',
  operationId: 'addItemMedia',
  summary: 'Add an image or a datasheet to an item',
  description:
    'The file must already be uploaded and confirmed (`/v1/media`). An image becomes the main one when the item has none, or when `main` is set; a PDF or other file is a datasheet. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  idempotent: true,
  params: itemParams,
  query: noSchema,
  body: z.object({
    fileId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    main: z.boolean().optional(),
  }),
  responses: {
    201: {
      description: 'The item’s files as they are now.',
      schema: z.object({ items: z.array(itemMediaSchema) }),
    },
    404: { description: 'No such item or file.' },
    422: { description: 'Only an image can be the main one (`main_not_image`).' },
  },
  handler: async ({ params, body }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      await requireItem(tx, params.itemId);
      await requireAttachable(tx, context, { itemId: params.itemId });
      const file = await tx.files.find(body.fileId);
      if (file?.deletedAt !== null) {
        throw notFound('This file does not exist.');
      }
      const image = isImage(file.contentType);
      if (body.main === true && !image) {
        throw unprocessable('main_not_image', 'Only an image can be the item’s main image.');
      }
      const current = await tx.attachments.list({ itemId: params.itemId });
      const attachment = await tx.attachments.add(
        { itemId: params.itemId },
        { fileId: file.id, title: body.title, kind: image ? 'photo' : 'manual' },
        context.principal.userId,
      );
      if (image && (body.main === true || !current.some((existing) => existing.isMain))) {
        await tx.attachments.setMain(attachment.id);
      }
      await audit(tx, context, 'inventory_item.media_added', 'inventory_item', params.itemId, {
        attachmentId: attachment.id,
        kind: image ? 'image' : 'datasheet',
      });
      return itemMedia(tx, params.itemId);
    });
    return { status: 201, body: { items } };
  },
});

async function requireItemAttachment(
  tx: TenantTransaction,
  context: RequestContext,
  itemId: string,
  attachmentId: string,
) {
  const attachment = await tx.attachments.find(attachmentId);
  if (
    attachment === undefined ||
    !('itemId' in attachment.owner) ||
    attachment.owner.itemId !== itemId
  ) {
    throw notFound('This file is not on this item.');
  }
  await requireAttachable(tx, context, attachment.owner);
  return attachment;
}

const attachmentParams = itemParams.extend({ attachmentId: z.uuid() });

export const setMainItemImageRoute = defineRoute({
  method: 'post',
  path: '/v1/inventory/items/:itemId/media/:attachmentId/main',
  operationId: 'setMainItemImage',
  summary: 'Make an image the item’s main one',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: attachmentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The item’s files as they are now.',
      schema: z.object({ items: z.array(itemMediaSchema) }),
    },
    404: { description: 'No such file on this item.' },
    422: { description: 'Only an image can be the main one (`main_not_image`).' },
  },
  handler: async ({ params }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const attachment = await requireItemAttachment(
        tx,
        context,
        params.itemId,
        params.attachmentId,
      );
      const file = await tx.files.find(attachment.fileId);
      if (file === undefined || !isImage(file.contentType)) {
        throw unprocessable('main_not_image', 'Only an image can be the item’s main image.');
      }
      await tx.attachments.setMain(attachment.id);
      await audit(tx, context, 'inventory_item.main_image_set', 'inventory_item', params.itemId, {
        attachmentId: attachment.id,
      });
      return itemMedia(tx, params.itemId);
    });
    return { status: 200, body: { items } };
  },
});

export const removeItemMediaRoute = defineRoute({
  method: 'delete',
  path: '/v1/inventory/items/:itemId/media/:attachmentId',
  operationId: 'removeItemMedia',
  summary: 'Take an image or datasheet off an item',
  description:
    'The file stays in storage until deleted through `/v1/media`. Removing the main image leaves the item without one until another is chosen.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.manage',
  feature: FEATURE,
  params: attachmentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The item’s files as they are now.',
      schema: z.object({ items: z.array(itemMediaSchema) }),
    },
    404: { description: 'No such file on this item.' },
    409: { description: 'Already removed (`attachment_removed`).' },
  },
  handler: async ({ params }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const attachment = await requireItemAttachment(
        tx,
        context,
        params.itemId,
        params.attachmentId,
      );
      if (!(await tx.attachments.remove(attachment.id, context.principal.userId))) {
        throw conflict('attachment_removed', 'This file was already removed.');
      }
      await audit(tx, context, 'inventory_item.media_removed', 'inventory_item', params.itemId, {
        attachmentId: attachment.id,
      });
      return itemMedia(tx, params.itemId);
    });
    return { status: 200, body: { items } };
  },
});

export const itemMediaRoutes = [
  listItemMediaRoute,
  addItemMediaRoute,
  setMainItemImageRoute,
  removeItemMediaRoute,
];
