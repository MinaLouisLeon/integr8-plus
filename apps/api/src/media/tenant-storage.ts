import { getPlatformDataSource, type TenantBucket, withTenant } from '@integr8/db';
import type { MediaStorage, ObjectStore } from './storage.js';

/**
 * A company's bucket: creating it, reaching it, and removing it.
 *
 * Provisioning and purging are platform operations, run by the worker and the
 * `storage` command as the schema owner — never while serving a company's
 * request. A request only reads which bucket is its own, through its tenant
 * transaction, which is what {@link getStorage} does.
 */

export class StorageNotReadyError extends Error {
  constructor(tenantId: string, reason: 'not_provisioned' | 'purged' | 'provider_changed') {
    super(`Storage for company ${tenantId} is not available: ${reason}.`);
    this.name = 'StorageNotReadyError';
    this.reason = reason;
  }

  readonly reason: 'not_provisioned' | 'purged' | 'provider_changed';
}

/**
 * The bucket feature code reads and writes a company's files in.
 *
 * The one entry point, so that the provider behind it can change without any
 * route, job or test knowing.
 */
export async function getStorage(media: MediaStorage, tenantId: string): Promise<ObjectStore> {
  const location = await withTenant(tenantId, (tx) => tx.files.storageLocation());
  if (location === undefined) {
    throw new StorageNotReadyError(tenantId, 'not_provisioned');
  }
  if (location.purged) {
    throw new StorageNotReadyError(tenantId, 'purged');
  }
  if (location.provider !== media.provider) {
    throw new StorageNotReadyError(tenantId, 'provider_changed');
  }
  return media.open(location.bucket);
}

/** Creates a company's bucket and records it. Safe to repeat. */
export async function provisionTenantStorage(
  media: MediaStorage,
  tenantId: string,
): Promise<TenantBucket> {
  const registry = getPlatformDataSource().storage;
  const existing = await registry.find(tenantId);
  if (existing !== undefined) {
    if (existing.provider !== media.provider) {
      throw new Error(
        `Company ${tenantId} keeps its files in ${existing.provider}, not ${media.provider}. Moving a company between providers is not supported.`,
      );
    }
    if (existing.purgedAt === null) {
      // Re-applying settings is cheap and repairs a bucket whose CORS rules drifted.
      await media.provision(existing.bucket);
    }
    return existing;
  }
  const bucket = media.bucketFor(tenantId);
  await media.provision(bucket);
  return registry.record({ tenantId, provider: media.provider, bucket });
}

/**
 * Removes every file a company has, from storage and from the ledger.
 *
 * Bytes first, then records: if the bucket cannot be emptied, the ledger still
 * says what is in it. Running it again after a failure finishes the job.
 */
export async function purgeTenantStorage(
  media: MediaStorage,
  tenantId: string,
): Promise<{ bucket: string | null; files: number; intents: number }> {
  const registry = getPlatformDataSource().storage;
  const existing = await registry.find(tenantId);
  if (existing === undefined) {
    return { bucket: null, files: 0, intents: 0 };
  }
  if (existing.provider !== media.provider) {
    throw new Error(
      `Company ${tenantId} keeps its files in ${existing.provider}; run this with MEDIA_STORAGE=${existing.provider}.`,
    );
  }
  await media.destroy(existing.bucket);
  const removed = await registry.purgeRecords(tenantId);
  return { bucket: existing.bucket, ...removed };
}
