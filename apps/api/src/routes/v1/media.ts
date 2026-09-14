import { withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { isAcceptableMediaType } from '../../media/storage.js';
import { iso } from './schemas.js';

/**
 * Uploading a file an answer will point at: a photo, a signature, a document.
 *
 *   1. POST /v1/media               → a record, and a link to send the bytes to
 *   2. PUT  <link>                  → the bytes, straight to storage
 *   3. POST /v1/media/:id/complete  → the API checks what arrived, and marks it stored
 *
 * Only a stored object may be named in a submission, and only with the type and
 * size storage actually holds. So a client cannot claim a photo it never sent,
 * or send a 2 GB file as "a 90 KB JPEG".
 */

const TAGS = ['media'];
const UPLOAD_LINK_SECONDS = 15 * 60;
const DOWNLOAD_LINK_SECONDS = 5 * 60;

const mediaSchema = z.object({
  id: z.uuid(),
  contentType: z.string(),
  byteSize: z.number().int(),
  status: z.enum(['pending', 'stored']),
  createdAt: z.string(),
});

const mediaParams = z.object({ mediaId: z.uuid() });

export const createMediaRoute = defineRoute({
  method: 'post',
  path: '/v1/media',
  operationId: 'createMediaUpload',
  summary: 'Start uploading a file',
  description:
    'Records the upload and returns where to send the bytes, with the headers to send. The link expires in fifteen minutes. Honours `Idempotency-Key`.',
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
        media: mediaSchema,
        upload: z.object({
          url: z.string(),
          method: z.literal('PUT'),
          headers: z.record(z.string(), z.string()),
          expiresAt: z.string(),
        }),
      }),
    },
  },
  handler: async ({ body }, context) => {
    const { config, services, principal } = context;
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

    const storageKey = `${principal.tenantId}/${randomUUID()}`;
    const media = await withTenant(principal.tenantId, (tx) =>
      tx.media.create({
        contentType: body.contentType,
        byteSize: body.byteSize,
        storageKey,
        createdBy: principal.userId,
      }),
    );
    const upload = await services.media.createUpload({
      key: storageKey,
      contentType: media.contentType,
      byteSize: media.byteSize,
      expiresInSeconds: UPLOAD_LINK_SECONDS,
    });

    return {
      status: 201,
      body: {
        media: {
          id: media.id,
          contentType: media.contentType,
          byteSize: media.byteSize,
          status: media.status,
          createdAt: iso(media.createdAt),
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
    'Checks storage holds exactly the type and size that were declared, then marks the file stored. Only a stored file can be named in a submission.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The stored file.', schema: mediaSchema },
    404: { description: 'No such upload.' },
    409: { description: 'Nothing, or something different, arrived in storage.' },
  },
  handler: async ({ params }, context) => {
    const { services, principal } = context;
    const media = await withTenant(principal.tenantId, (tx) => tx.media.find(params.mediaId));
    if (media === undefined) {
      throw notFound('This upload does not exist.');
    }
    if (media.status === 'pending') {
      const found = await services.media.stat(media.storageKey);
      if (found?.byteSize !== media.byteSize || found.contentType !== media.contentType) {
        throw conflict(
          'upload_incomplete',
          'The file has not arrived in storage, or is not what was declared. Upload it again.',
        );
      }
      await withTenant(principal.tenantId, (tx) => tx.media.markStored(media.id));
    }
    return {
      status: 200,
      body: {
        id: media.id,
        contentType: media.contentType,
        byteSize: media.byteSize,
        status: 'stored' as const,
        createdAt: iso(media.createdAt),
      },
    };
  },
});

export const getMediaRoute = defineRoute({
  method: 'get',
  path: '/v1/media/:mediaId',
  operationId: 'getMedia',
  summary: 'A link to read a stored file',
  description:
    'Anyone in the company may read a file they have the id of: ids are unguessable and are only handed out inside submissions the reader can already see. The link expires in five minutes.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: mediaParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The file and a link to it.',
      schema: mediaSchema.extend({ url: z.string(), expiresAt: z.string() }),
    },
    404: { description: 'No such stored file.' },
  },
  handler: async ({ params }, context) => {
    const { services, principal } = context;
    const media = await withTenant(principal.tenantId, (tx) => tx.media.find(params.mediaId));
    if (media?.status !== 'stored') {
      throw notFound('This file does not exist.');
    }
    const link = await services.media.createDownload({
      key: media.storageKey,
      contentType: media.contentType,
      expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    });
    return {
      status: 200,
      body: {
        id: media.id,
        contentType: media.contentType,
        byteSize: media.byteSize,
        status: media.status,
        createdAt: iso(media.createdAt),
        url: link.url,
        expiresAt: iso(link.expiresAt),
      },
    };
  },
});

export const mediaRoutes = [createMediaRoute, completeMediaRoute, getMediaRoute];
