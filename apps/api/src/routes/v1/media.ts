import { can } from '@integr8/core';
import { type FileRecord, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  categoryOf,
  isAcceptableMediaType,
  mediaKey,
  type ObjectStore,
} from '../../media/storage.js';
import { getStorage, StorageNotReadyError } from '../../media/tenant-storage.js';
import { THUMBNAIL_QUEUE } from '../../media/thumbnails.js';
import { iso } from './schemas.js';

/**
 * Uploading a file an answer will point at: a photo, a signature, a document.
 *
 *   1. POST /v1/media               → an upload intent, and a link to send the bytes to
 *   2. PUT  <link>                  → the bytes, straight to the company's bucket
 *   3. POST /v1/media/:id/complete  → the API reads back what arrived, and records it
 *
 * What is recorded — and billed — is what storage reports on read-back, never
 * what the client declared. The link is signed for the declared type and size,
 * so storage refuses anything else; if something different is there all the
 * same, it is deleted and nothing is recorded.
 */

const TAGS = ['media'];
const UPLOAD_LINK_SECONDS = 15 * 60;
/** How long after its link expires an upload can still be confirmed, before the sweeper may take it. */
const CONFIRM_GRACE_SECONDS = 15 * 60;
const DOWNLOAD_LINK_SECONDS = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const mediaSchema = z.object({
  id: z.uuid(),
  contentType: z.string(),
  byteSize: z.number().int(),
  status: z.enum(['pending', 'stored', 'deleted']),
  thumbnail: z.enum(['none', 'pending', 'ready', 'failed']),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  /** When a deleted file's bytes are removed for good. Until then it can be restored. */
  purgeAfter: z.string().nullable(),
});

const mediaParams = z.object({ mediaId: z.uuid() });

function describe(file: FileRecord) {
  return {
    id: file.id,
    contentType: file.contentType,
    byteSize: file.byteSize,
    status: file.deletedAt === null ? ('stored' as const) : ('deleted' as const),
    thumbnail: file.thumbnailStatus,
    createdAt: iso(file.createdAt),
    deletedAt: file.deletedAt === null ? null : iso(file.deletedAt),
    purgeAfter: file.purgeAfter === null ? null : iso(file.purgeAfter),
  };
}

async function storageFor(context: RequestContext): Promise<ObjectStore> {
  try {
    return await getStorage(context.services.media, context.principal.tenantId);
  } catch (error) {
    if (error instanceof StorageNotReadyError) {
      throw new ApiError(
        503,
        'storage_not_ready',
        "This company's file storage is not available yet. Try again in a few minutes.",
      );
    }
    throw error;
  }
}

export const createMediaRoute = defineRoute({
  method: 'post',
  path: '/v1/media',
  operationId: 'createMediaUpload',
  summary: 'Start uploading a file',
  description:
    'Returns where to send the bytes, with the headers to send. The link is signed for exactly this type and size and expires in fifteen minutes. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    contentType: z.string().max(127),
    byteSize: z.number().int().positive(),
  }),
  responses: {
    201: {
      description: 'The pending upload and where to send it.',
      schema: z.object({
        media: z.object({
          id: z.uuid(),
          contentType: z.string(),
          byteSize: z.number().int(),
          status: z.literal('pending'),
          createdAt: z.string(),
        }),
        upload: z.object({
          url: z.string(),
          method: z.literal('PUT'),
          headers: z.record(z.string(), z.string()),
          expiresAt: z.string(),
        }),
      }),
    },
    503: { description: "The company's storage is still being set up." },
  },
  handler: async ({ body }, context) => {
    const { config, principal } = context;
    if (!isAcceptableMediaType(body.contentType)) {
      throw unprocessable('media_type_refused', 'Files of this type cannot be uploaded.', [
        { field: 'body.contentType', code: 'media_type_refused', message: body.contentType },
      ]);
    }
    if (body.byteSize > config.MEDIA_MAX_BYTES) {
      throw unprocessable('media_too_large', 'This file is larger than uploads allow.', [
        {
          field: 'body.byteSize',
          code: 'media_too_large',
          message: `At most ${String(config.MEDIA_MAX_BYTES)} bytes.`,
          params: { maximum: String(config.MEDIA_MAX_BYTES) },
        },
      ]);
    }

    const store = await storageFor(context);
    const id = randomUUID();
    const intent = await withTenant(principal.tenantId, (tx) =>
      tx.files.createIntent({
        id,
        bucket: store.bucket,
        storageKey: mediaKey(id),
        contentType: body.contentType,
        declaredBytes: body.byteSize,
        category: categoryOf(body.contentType),
        createdBy: principal.userId,
        expiresAt: new Date(Date.now() + (UPLOAD_LINK_SECONDS + CONFIRM_GRACE_SECONDS) * 1000),
      }),
    );
    const upload = await store.createUpload({
      key: intent.storageKey,
      contentType: intent.contentType,
      byteSize: intent.declaredBytes,
      expiresInSeconds: UPLOAD_LINK_SECONDS,
    });

    return {
      status: 201,
      body: {
        media: {
          id: intent.id,
          contentType: intent.contentType,
          byteSize: intent.declaredBytes,
          status: 'pending' as const,
          createdAt: iso(intent.createdAt),
        },
        upload: { ...upload, expiresAt: iso(upload.expiresAt) },
      },
    };
  },
});

export const completeMediaRoute = defineRoute({
  method: 'post',
  path: '/v1/media/:mediaId/complete',
  operationId: 'completeMediaUpload',
  summary: 'Confirm an upload arrived',
  description:
    'Reads the object back from storage. If it is exactly the type and size declared, the file is recorded with the size and ETag storage reports, and can be named in a submission. If something else arrived, it is deleted and nothing is recorded. Confirming twice returns the same file.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The recorded file.', schema: mediaSchema },
    404: { description: 'No such upload.' },
    409: {
      description:
        'Nothing has arrived yet (`upload_incomplete`), something other than what was declared arrived and was discarded (`upload_mismatch`), or the upload window closed (`upload_expired`).',
    },
    503: { description: "The company's storage is not available." },
  },
  handler: async ({ params }, context) => {
    const { config, principal } = context;
    const tenantId = principal.tenantId;

    const recorded = await withTenant(tenantId, (tx) => tx.files.find(params.mediaId));
    if (recorded !== undefined) {
      if (recorded.purgedAt !== null) {
        throw notFound('This upload does not exist.');
      }
      return { status: 200, body: describe(recorded) };
    }

    const intent = await withTenant(tenantId, (tx) => tx.files.findIntent(params.mediaId));
    if (intent === undefined) {
      throw notFound('This upload does not exist.');
    }
    if (intent.expiresAt.getTime() <= Date.now()) {
      throw conflict('upload_expired', 'This upload took too long to confirm. Upload it again.');
    }

    const store = await storageFor(context);
    const found = await store.head(intent.storageKey);
    if (found === undefined) {
      throw conflict(
        'upload_incomplete',
        'The file has not arrived in storage yet. Finish sending it, then confirm again.',
      );
    }
    if (
      found.byteSize !== intent.declaredBytes ||
      found.contentType !== intent.contentType ||
      found.byteSize > config.MEDIA_MAX_BYTES
    ) {
      await store.delete([intent.storageKey]);
      await withTenant(tenantId, (tx) => tx.files.deleteIntent(intent.id));
      throw conflict(
        'upload_mismatch',
        'What arrived is not the file that was declared, so it was discarded. Upload it again.',
      );
    }

    const file = await withTenant(tenantId, async (tx) => {
      const confirmed = await tx.files.confirm(intent.id, found);
      if (confirmed?.thumbnailStatus === 'pending') {
        await tx.jobs.enqueue({ queue: THUMBNAIL_QUEUE, payload: { fileId: confirmed.id } });
      }
      // Undefined when a concurrent confirmation claimed the intent first.
      return confirmed ?? (await tx.files.find(intent.id));
    });
    if (file === undefined) {
      throw notFound('This upload does not exist.');
    }
    return { status: 200, body: describe(file) };
  },
});

export const getMediaRoute = defineRoute({
  method: 'get',
  path: '/v1/media/:mediaId',
  operationId: 'getMedia',
  summary: 'A link to read a stored file',
  description:
    'Anyone in the company may read a file they have the id of: ids are unguessable and are only handed out inside submissions the reader can already see. Links expire in five minutes; `thumbnailUrl` is set once a thumbnail has been made.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The file and links to it.',
      schema: mediaSchema.extend({
        url: z.string(),
        thumbnailUrl: z.string().nullable(),
        expiresAt: z.string(),
      }),
    },
    404: { description: 'No such stored file, or it was deleted.' },
  },
  handler: async ({ params }, context) => {
    const file = await withTenant(context.principal.tenantId, (tx) =>
      tx.files.find(params.mediaId),
    );
    if (file?.deletedAt !== null) {
      throw notFound('This file does not exist.');
    }
    const store = await storageFor(context);
    const link = await store.createDownload({
      key: file.storageKey,
      contentType: file.contentType,
      expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    });
    const thumbnail =
      file.thumbnailKey === null
        ? null
        : await store.createDownload({
            key: file.thumbnailKey,
            contentType: 'image/webp',
            expiresInSeconds: DOWNLOAD_LINK_SECONDS,
          });
    return {
      status: 200,
      body: {
        ...describe(file),
        url: link.url,
        thumbnailUrl: thumbnail?.url ?? null,
        expiresAt: iso(link.expiresAt),
      },
    };
  },
});

/** Who may delete or restore a file: whoever uploaded it, or someone who corrects submissions. */
function assertMayManage(file: FileRecord, context: RequestContext) {
  const { principal } = context;
  if (file.uploadedBy !== principal.userId && !can(principal.role, 'submission.amend')) {
    throw forbidden('Only the person who uploaded this file, or an admin, can do that.');
  }
}

async function auditFile(context: RequestContext, action: string, file: FileRecord) {
  await withTenant(context.principal.tenantId, (tx) =>
    tx.auditLog.append({
      actorKind: 'tenant_user',
      actorId: context.principal.userId,
      actorLabel: context.principal.userId,
      action,
      resourceType: 'file',
      resourceId: file.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { byteSize: file.byteSize, contentType: file.contentType },
    }),
  );
}

export const deleteMediaRoute = defineRoute({
  method: 'delete',
  path: '/v1/media/:mediaId',
  operationId: 'deleteMedia',
  summary: 'Delete a file',
  description:
    'Deletes a file no submission names. It can be restored until `purgeAfter`; after that its bytes are removed from storage. A file a submission or its history names cannot be deleted.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The deleted file.', schema: mediaSchema },
    404: { description: 'No such file.' },
    409: { description: 'A submission names this file (`media_in_use`).' },
  },
  handler: async ({ params }, context) => {
    const { config, principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const file = await tx.files.find(params.mediaId);
      if (file?.purgedAt !== null) {
        throw notFound('This file does not exist.');
      }
      assertMayManage(file, context);
      if (file.deletedAt !== null) {
        return { file, changed: false };
      }
      if (await tx.files.isReferenced(file.id)) {
        throw conflict(
          'media_in_use',
          'A submission uses this file, so it cannot be deleted. Remove it from the submission first.',
        );
      }
      const deleted = await tx.files.softDelete(
        file.id,
        principal.userId,
        new Date(Date.now() + config.MEDIA_RESTORE_DAYS * DAY_MS),
      );
      return { file: deleted ?? file, changed: deleted !== undefined };
    });
    if (result.changed) {
      await auditFile(context, 'file.deleted', result.file);
    }
    return { status: 200, body: describe(result.file) };
  },
});

export const restoreMediaRoute = defineRoute({
  method: 'post',
  path: '/v1/media/:mediaId/restore',
  operationId: 'restoreMedia',
  summary: 'Restore a deleted file',
  description: 'Undoes a deletion, until the file’s `purgeAfter`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The restored file.', schema: mediaSchema },
    404: { description: 'No such file.' },
    409: { description: 'The restore window has passed (`restore_window_passed`).' },
  },
  handler: async ({ params }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const file = await tx.files.find(params.mediaId);
      if (file === undefined) {
        throw notFound('This file does not exist.');
      }
      assertMayManage(file, context);
      if (file.deletedAt === null) {
        return { file, changed: false };
      }
      const restored = await tx.files.restore(file.id, new Date());
      if (restored === undefined) {
        throw conflict('restore_window_passed', 'This file was deleted too long ago to restore.');
      }
      return { file: restored, changed: true };
    });
    if (result.changed) {
      await auditFile(context, 'file.restored', result.file);
    }
    return { status: 200, body: describe(result.file) };
  },
});

export const storageUsageRoute = defineRoute({
  method: 'get',
  path: '/v1/storage/usage',
  operationId: 'getStorageUsage',
  summary: "The company's storage use",
  description:
    'Bytes and objects in the company’s bucket, by kind, as the ledger records them. Deleted files count until their bytes are removed; thumbnails are their own kind.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'storage.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Storage use.',
      schema: z.object({
        categories: z.array(
          z.object({
            category: z.enum(['image', 'video', 'document', 'other', 'thumbnail']),
            bytes: z.number().int(),
            objects: z.number().int(),
          }),
        ),
        totalBytes: z.number().int(),
        totalObjects: z.number().int(),
      }),
    },
  },
  handler: async (_input, context) => {
    const usage = await withTenant(context.principal.tenantId, (tx) => tx.files.usage());
    return { status: 200, body: usage };
  },
});

export const mediaRoutes = [
  createMediaRoute,
  completeMediaRoute,
  getMediaRoute,
  deleteMediaRoute,
  restoreMediaRoute,
  storageUsageRoute,
];
