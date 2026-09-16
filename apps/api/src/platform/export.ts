import { getPlatformDataSource, withTenant } from '@integr8/db';
import { gzipSync } from 'node:zlib';
import type { Logger } from '../http/logger.js';
import type { MediaStorage } from '../media/storage.js';
import { exportKey, getExportStore } from '../media/tenant-storage.js';

/**
 * Everything a company has, as one file (P15).
 *
 * Two things need this and they want the same thing: a customer who asks for
 * their data, and the deletion flow, which refuses to schedule a purge without
 * a finished export. Making them the same code path means the export that
 * justifies a deletion is the same one a customer would have been given —
 * there is no "deletion export" that quietly holds less.
 *
 * Shape: one gzipped JSON document, `{ tenant, exportedAt, tables: { … } }`,
 * written into the platform's export bucket — not the company's own, which the
 * purge destroys. JSON rather than CSV per table
 * because the relationships matter and a folder of CSVs loses them; one file
 * rather than many because the thing a person has to keep should be one thing.
 *
 * It is read through the tenant connection, so RLS applies: an export cannot
 * contain a row the company itself could not have read. That is slower than
 * reading as the schema owner, and it is the whole guarantee.
 */

export const EXPORT_QUEUE = 'tenant.export';

/** How long an export stays downloadable before it is swept. */
export const EXPORT_TTL_DAYS = 30;

export interface RunExportInput {
  exportId: string;
  tenantId: string;
  media: MediaStorage;
  logger: Logger;
  now?: Date;
}

export async function runTenantExport(input: RunExportInput): Promise<void> {
  const platform = getPlatformDataSource();
  const lifecycle = platform.lifecycle;
  const now = input.now ?? new Date();

  const record = await lifecycle.findExport(input.exportId);
  if (record === undefined) {
    input.logger.warn('Export job for an export that no longer exists', {
      exportId: input.exportId,
    });
    return;
  }
  if (record.status !== 'pending') {
    // Already running or finished: a retry after a crash must not write a
    // second archive over a good one.
    input.logger.info('Export already handled', {
      exportId: record.id,
      status: record.status,
    });
    return;
  }

  await lifecycle.markExportRunning(record.id);

  try {
    const { tables, counts } = await withTenant(input.tenantId, async (tx) =>
      tx.dataExport.readAll(),
    );
    const tenant = await platform.tenants.findById(input.tenantId);

    const document = {
      tenant: {
        id: input.tenantId,
        slug: record.tenantSlug,
        name: tenant?.name ?? record.tenantSlug,
      },
      exportedAt: now.toISOString(),
      tables,
    };

    const body = gzipSync(Buffer.from(JSON.stringify(document), 'utf8'));
    const key = exportKey(input.tenantId, record.id);

    // The platform's bucket, not the company's: the purge destroys theirs, and
    // an export that died with the company it was taken from would be no export
    // at all.
    const store = await getExportStore(input.media);
    await store.put({ key, body, contentType: 'application/gzip' });

    await lifecycle.completeExport({
      id: record.id,
      objectKey: key,
      byteSize: body.byteLength,
      contents: counts,
      expiresAt: new Date(now.getTime() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000),
      now,
    });

    input.logger.info('Export written', {
      exportId: record.id,
      bytes: body.byteLength,
      tables: Object.keys(counts).length,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await lifecycle.failExport(record.id, reason, now);
    // Rethrown so the job is retried: an export that failed because R2 was
    // briefly unreachable should be tried again, and one that keeps failing
    // should end up dead-lettered where somebody sees it.
    throw error;
  }
}
