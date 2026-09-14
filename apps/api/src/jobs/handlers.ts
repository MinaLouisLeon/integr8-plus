import { withTenant } from '@integr8/db';
import type { Services } from '../composition.js';
import { GEOCODE_QUEUE, geocodeSite } from '../geo/geocode-site.js';
import { IMPORT_QUEUE, runImport } from '../imports/run-import.js';
import { makeThumbnail, THUMBNAIL_QUEUE } from '../media/thumbnails.js';
import type { JobHandlers } from './worker.js';

/**
 * The job handlers this build knows, over the same services the API uses.
 *
 * Writing an audit entry from a background job is how a slow or failure-prone
 * side effect stops blocking the request that caused it; a thumbnail is the
 * same idea for an uploaded image.
 *
 * Later phases add to this map. A job whose queue has no handler here is
 * dead-lettered rather than retried, because another attempt will not teach
 * this process a handler it does not have.
 */
export const buildJobHandlers = (services: Pick<Services, 'media' | 'geocoder'>): JobHandlers => ({
  'audit.record': async (payload, context) => {
    await withTenant(context.tenantId, (tx) =>
      tx.auditLog.append({
        actorKind: 'system',
        actorLabel: 'system',
        action: text(payload, 'action') ?? 'system.event',
        resourceType: text(payload, 'resourceType') ?? 'system',
        resourceId: text(payload, 'resourceId'),
        metadata: { jobId: context.jobId, ...object(payload, 'metadata') },
      }),
    );
  },

  [THUMBNAIL_QUEUE]: async (payload, context) => {
    const fileId = text(payload, 'fileId');
    if (fileId === null) {
      context.logger.warn('Thumbnail job without a file id', { jobId: context.jobId });
      return;
    }
    const outcome = await makeThumbnail(services.media, context.tenantId, fileId);
    context.logger.info('Thumbnail job finished', { jobId: context.jobId, fileId, outcome });
  },

  [GEOCODE_QUEUE]: async (payload, context) => {
    const siteId = text(payload, 'siteId');
    if (siteId === null) {
      context.logger.warn('Geocode job without a site id', { jobId: context.jobId });
      return;
    }
    const outcome = await geocodeSite(services.geocoder, context.tenantId, siteId, context.attempt);
    context.logger.info('Geocode job finished', { jobId: context.jobId, siteId, outcome });
  },

  [IMPORT_QUEUE]: async (payload, context) => {
    const importId = text(payload, 'importId');
    if (importId === null) {
      context.logger.warn('Import job without an import id', { jobId: context.jobId });
      return;
    }
    try {
      const outcome = await runImport({
        tenantId: context.tenantId,
        importId,
        timeZone: text(payload, 'timeZone') ?? 'UTC',
        logger: context.logger,
      });
      context.logger.info('Import job finished', { jobId: context.jobId, importId, outcome });
    } catch (error) {
      // Rows already written stay written; running it again would write them twice.
      // So an import that stops part-way is recorded as failed, with the count it reached.
      await withTenant(context.tenantId, (tx) =>
        tx.imports.finish(importId, 'failed', [
          {
            row: 0,
            column: null,
            code: 'interrupted',
            message:
              'The import stopped part-way. Rows counted as imported were saved; check the rest before importing them again.',
          },
        ]),
      );
      throw error;
    }
  },
});

/**
 * Reads a string out of a job payload.
 *
 * A payload is `unknown` by the time it comes back from the database — it was
 * JSON when it went in and a later build may have changed what it writes. These
 * two helpers make that explicit rather than coercing whatever is there into
 * `[object Object]`.
 */
function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function object(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
