import { getPlatformDataSource } from '@integr8/db';
import type { Logger } from '../http/logger.js';
import type { MediaStorage } from '../media/storage.js';
import { purgeTenantStorage } from '../media/tenant-storage.js';

/**
 * Removing a company for good (P15).
 *
 * This is the one thing in the system that cannot be undone, so nearly all of
 * the care is spent before it runs: an export has to exist, a schedule has to
 * be written, and a cooling-off period has to pass. By the time this function
 * is called the decision is a week old and somebody could have cancelled it
 * every day since.
 *
 * Two stores have to be emptied and they cannot be emptied atomically, so the
 * order matters. Bucket first, then rows:
 *
 * - bucket first, rows second, and a crash in between leaves rows pointing at
 *   objects that are gone — recoverable, visible, and the purge simply runs
 *   again;
 * - rows first, bucket second, and a crash in between leaves a bucket nobody
 *   has a record of, which is a customer's data sitting in Cloudflare with
 *   nothing left to say whose it was or that it should go.
 *
 * The second is the one that ends up in a regulator's letter, so: bucket first.
 *
 * The row deletion itself is `purge_tenant()` in the database, which refuses
 * unless a deletion is scheduled and due — so an accidental call here deletes
 * nothing.
 */

export const PURGE_QUEUE = 'tenant.purge';

export interface PurgeResult {
  tenantId: string;
  bucket: string | null;
  files: number;
  purged: boolean;
}

/**
 * Purges every company whose cooling-off has passed.
 *
 * Called on a schedule rather than per company, because the thing that has to
 * be reliable is that a due deletion eventually runs — including one whose job
 * row was lost with the process that held it.
 */
export async function purgeDueTenants(input: {
  media: MediaStorage;
  logger: Logger;
  now?: Date;
}): Promise<PurgeResult[]> {
  const platform = getPlatformDataSource();
  const due = await platform.lifecycle.due(input.now ?? new Date());
  const results: PurgeResult[] = [];

  for (const deletion of due) {
    results.push(await purgeOne(deletion.tenantId, input));
  }

  return results;
}

export async function purgeOne(
  tenantId: string,
  input: { media: MediaStorage; logger: Logger },
): Promise<PurgeResult> {
  const platform = getPlatformDataSource();

  const storage = await purgeTenantStorage(input.media, tenantId);
  input.logger.info('Company bucket emptied and removed', {
    tenantId,
    bucket: storage.bucket,
    files: storage.files,
  });

  await platform.lifecycle.purge(tenantId);
  input.logger.info('Company rows removed', { tenantId });

  // After the company is gone, not before: an entry naming a company that still
  // exists would be a lie for however long the purge took. The platform audit
  // log has no foreign key to `tenants` precisely so this can be written.
  await platform.platformAudit.append({
    platformUserId: null,
    actorLabel: 'purge job',
    action: 'tenant.purged',
    tenantId,
    targetKind: 'tenant',
    targetId: tenantId,
    metadata: { bucket: storage.bucket, files: storage.files },
  });

  return { tenantId, bucket: storage.bucket, files: storage.files, purged: true };
}
