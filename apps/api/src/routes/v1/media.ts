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
  MULTIPART_PART_BYTES,
  type ObjectStore,
} from '../../media/storage.js';
import { getStorage, StorageNotReadyError } from '../../media/tenant-storage.js';
import { RESUMABLE_UPLOAD_DAYS } from '../../media/maintenance.js';
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
    if (intent.multipart !== null) {
      await joinParts(store, intent.storageKey, intent.declaredBytes, intent.multipart);
    }
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

// ---------------------------------------------------------------------------
// Resumable uploads (P12)
// ---------------------------------------------------------------------------

const RESUMABLE_UPLOAD_MS = RESUMABLE_UPLOAD_DAYS * DAY_MS;

/** How many parts a multipart upload of `byteSize` has, and the size of each. */
function partPlan(byteSize: number, partSize: number) {
  const count = Math.ceil(byteSize / partSize);
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    byteSize: index === count - 1 ? byteSize - partSize * (count - 1) : partSize,
  }));
}

/** Completes a multipart upload once every part has arrived at its planned size. */
async function joinParts(
  store: ObjectStore,
  key: string,
  byteSize: number,
  multipart: { uploadId: string; partSize: number },
) {
  const plan = partPlan(byteSize, multipart.partSize);
  const stored = await store.listParts({ key, uploadId: multipart.uploadId });
  const byNumber = new Map(stored.map((part) => [part.number, part]));
  const missing = plan.filter((part) => byNumber.get(part.number)?.byteSize !== part.byteSize);
  if (missing.length > 0) {
    if ((await store.head(key)) !== undefined) {
      // Joined by an earlier confirmation whose reply was lost.
      return;
    }
    throw new ApiError(
      409,
      'upload_incomplete',
      'Some parts of this file have not arrived yet. Send them, then confirm again.',
      missing.slice(0, 50).map((part) => ({
        field: `parts.${String(part.number)}`,
        code: 'part_missing',
        message: `Part ${String(part.number)} of ${String(plan.length)}`,
      })),
    );
  }
  await store.completeMultipartUpload({
    key,
    uploadId: multipart.uploadId,
    parts: plan.map((part) => byNumber.get(part.number)!),
  });
}

const resumableUploadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('single'),
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    linkExpiresAt: z.string(),
  }),
  z.object({
    kind: z.literal('multipart'),
    partSize: z.number().int(),
    partCount: z.number().int(),
  }),
]);

const preparedUploadSchema = z.object({
  media: z.object({
    id: z.uuid(),
    contentType: z.string(),
    byteSize: z.number().int(),
    status: z.enum(['pending', 'stored']),
  }),
  upload: resumableUploadSchema.nullable(),
});

export const prepareMediaRoute = defineRoute({
  method: 'put',
  path: '/v1/media/:mediaId',
  operationId: 'prepareMediaUpload',
  summary: 'Start or resume uploading a file, by an id the client chose',
  description:
    'For a phone that names a file in its answers before it has signal (P12). The first call records the upload; every later call with the same id and the same type and size answers again — with a fresh link, or `stored` once it has been confirmed — so it can be repeated after any interruption. Files larger than 8 MiB arrive in parts (`multipart`), which can be sent over several connections and resumed. An unconfirmed upload is kept for seven days.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: z.object({
    contentType: z.string().max(127),
    byteSize: z.number().int().positive(),
  }),
  responses: {
    200: {
      description: 'Where the upload stands, and how to send what is missing.',
      schema: preparedUploadSchema,
    },
    409: { description: 'The id belongs to a different file (`media_id_taken`).' },
    503: { description: "The company's storage is still being set up." },
  },
  handler: async (
    { params, body },
    context,
  ): Promise<{ status: 200; body: z.infer<typeof preparedUploadSchema> }> => {
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
    const taken = () =>
      conflict('media_id_taken', 'This upload id already belongs to a different file.');
    const tenantId = principal.tenantId;

    const recorded = await withTenant(tenantId, (tx) => tx.files.find(params.mediaId));
    if (recorded !== undefined) {
      if (
        recorded.purgedAt !== null ||
        recorded.contentType !== body.contentType ||
        recorded.byteSize !== body.byteSize
      ) {
        throw taken();
      }
      return {
        status: 200,
        body: {
          media: {
            id: recorded.id,
            contentType: recorded.contentType,
            byteSize: recorded.byteSize,
            status: 'stored',
          },
          upload: null,
        },
      };
    }

    const store = await storageFor(context);
    const expiresAt = new Date(Date.now() + RESUMABLE_UPLOAD_MS);
    let intent = await withTenant(tenantId, (tx) => tx.files.findIntent(params.mediaId));
    if (intent !== undefined) {
      if (
        intent.createdBy !== principal.userId ||
        intent.contentType !== body.contentType ||
        intent.declaredBytes !== body.byteSize
      ) {
        throw taken();
      }
      const id = intent.id;
      intent = (await withTenant(tenantId, (tx) => tx.files.renewIntent(id, expiresAt))) ?? intent;
    } else {
      const multipart =
        body.byteSize > MULTIPART_PART_BYTES
          ? {
              uploadId: (
                await store.createMultipartUpload({
                  key: mediaKey(params.mediaId),
                  contentType: body.contentType,
                })
              ).uploadId,
              partSize: MULTIPART_PART_BYTES,
            }
          : undefined;
      try {
        intent = await withTenant(tenantId, (tx) =>
          tx.files.createIntent({
            id: params.mediaId,
            bucket: store.bucket,
            storageKey: mediaKey(params.mediaId),
            contentType: body.contentType,
            declaredBytes: body.byteSize,
            category: categoryOf(body.contentType),
            createdBy: principal.userId,
            expiresAt,
            ...(multipart === undefined ? {} : { multipart }),
          }),
        );
      } catch (error) {
        // Two first calls raced; the other one recorded it. Answer as a repeat would.
        const existing = await withTenant(tenantId, (tx) => tx.files.findIntent(params.mediaId));
        if (existing === undefined) {
          throw error;
        }
        if (multipart !== undefined) {
          await store.abortMultipartUpload({
            key: mediaKey(params.mediaId),
            uploadId: multipart.uploadId,
          });
        }
        intent = existing;
      }
    }

    const media = {
      id: intent.id,
      contentType: intent.contentType,
      byteSize: intent.declaredBytes,
      status: 'pending' as const,
    };
    if (intent.multipart !== null) {
      return {
        status: 200,
        body: {
          media,
          upload: {
            kind: 'multipart' as const,
            partSize: intent.multipart.partSize,
            partCount: partPlan(intent.declaredBytes, intent.multipart.partSize).length,
          },
        },
      };
    }
    const link = await store.createUpload({
      key: intent.storageKey,
      contentType: intent.contentType,
      byteSize: intent.declaredBytes,
      expiresInSeconds: UPLOAD_LINK_SECONDS,
    });
    return {
      status: 200,
      body: {
        media,
        upload: {
          kind: 'single' as const,
          url: link.url,
          method: link.method,
          headers: link.headers,
          linkExpiresAt: iso(link.expiresAt),
        },
      },
    };
  },
});

async function multipartIntent(context: RequestContext, mediaId: string) {
  const intent = await withTenant(context.principal.tenantId, (tx) => tx.files.findIntent(mediaId));
  if (intent?.createdBy !== context.principal.userId) {
    throw notFound('This upload does not exist.');
  }
  if (intent.multipart === null) {
    throw conflict('upload_not_multipart', 'This file is sent in one piece, not in parts.');
  }
  return { intent, multipart: intent.multipart };
}

export const createMediaPartLinksRoute = defineRoute({
  method: 'post',
  path: '/v1/media/:mediaId/parts',
  operationId: 'createMediaPartLinks',
  summary: 'Links to send parts of a file to',
  description:
    'Each link is signed for its part’s exact size and lasts fifteen minutes. Ask again for any part whose link expired.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: z.object({ partNumbers: z.array(z.number().int().min(1)).min(1).max(100) }),
  responses: {
    200: {
      description: 'A link for each part asked for.',
      schema: z.object({
        parts: z.array(
          z.object({
            number: z.number().int(),
            byteSize: z.number().int(),
            url: z.string(),
            method: z.literal('PUT'),
            headers: z.record(z.string(), z.string()),
            expiresAt: z.string(),
          }),
        ),
      }),
    },
    404: { description: 'No such upload by this person.' },
    409: { description: 'This upload is not in parts (`upload_not_multipart`).' },
    422: { description: 'A part number beyond the file.' },
  },
  handler: async ({ params, body }, context) => {
    const { intent, multipart } = await multipartIntent(context, params.mediaId);
    const plan = new Map(
      partPlan(intent.declaredBytes, multipart.partSize).map((part) => [part.number, part]),
    );
    const wanted = [...new Set(body.partNumbers)].map((number) => plan.get(number));
    if (wanted.some((part) => part === undefined)) {
      throw unprocessable('part_out_of_range', 'This file does not have that many parts.', [
        {
          field: 'body.partNumbers',
          code: 'part_out_of_range',
          message: `${String(plan.size)} parts`,
        },
      ]);
    }
    const store = await storageFor(context);
    const links = await store.createPartUploads({
      key: intent.storageKey,
      uploadId: multipart.uploadId,
      parts: wanted as { number: number; byteSize: number }[],
      expiresInSeconds: UPLOAD_LINK_SECONDS,
    });
    return {
      status: 200,
      body: {
        parts: links.map((link) => ({
          number: link.number,
          byteSize: plan.get(link.number)!.byteSize,
          url: link.url,
          method: link.method,
          headers: link.headers,
          expiresAt: iso(link.expiresAt),
        })),
      },
    };
  },
});

export const listMediaPartsRoute = defineRoute({
  method: 'get',
  path: '/v1/media/:mediaId/parts',
  operationId: 'listMediaParts',
  summary: 'The parts of a file that have arrived',
  description:
    'For resuming: after an interruption, a phone asks which parts storage already holds and sends only the rest.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The parts that arrived, and how many there are in all.',
      schema: z.object({
        partCount: z.number().int(),
        partSize: z.number().int(),
        arrived: z.array(z.object({ number: z.number().int(), byteSize: z.number().int() })),
      }),
    },
    404: { description: 'No such upload by this person.' },
    409: { description: 'This upload is not in parts (`upload_not_multipart`).' },
  },
  handler: async ({ params }, context) => {
    const { intent, multipart } = await multipartIntent(context, params.mediaId);
    const store = await storageFor(context);
    const plan = partPlan(intent.declaredBytes, multipart.partSize);
    const stored = await store.listParts({ key: intent.storageKey, uploadId: multipart.uploadId });
    const planned = new Map(plan.map((part) => [part.number, part.byteSize]));
    return {
      status: 200,
      body: {
        partCount: plan.length,
        partSize: multipart.partSize,
        arrived: stored
          .filter((part) => planned.get(part.number) === part.byteSize)
          .map((part) => ({ number: part.number, byteSize: part.byteSize })),
      },
    };
  },
});

export const mediaRoutes = [
  createMediaRoute,
  prepareMediaRoute,
  createMediaPartLinksRoute,
  listMediaPartsRoute,
  completeMediaRoute,
  getMediaRoute,
  deleteMediaRoute,
  restoreMediaRoute,
  storageUsageRoute,
];
