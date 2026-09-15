import { getPlatformDataSource, withTenant } from '@integr8/db';
import type { MediaStorage } from './storage.js';
import { provisionTenantStorage } from './tenant-storage.js';

/**
 * The media housekeeping the worker runs on a timer.
 *
 * Every step is idempotent and ordered so that a crash between two statements
 * leaves something the next run finishes, never an object the ledger does not
 * know about or a ledger row whose object is gone:
 *
 *   - provision  a bucket for any company that has none;
 *   - sweep      uploads whose window closed unconfirmed: object, then intent;
 *   - abort      uploads left halfway, whose parts occupy a bucket unseen;
 *   - purge      deleted files past their restore window: objects, then mark.
 */

/**
 * A multipart upload older than this cannot belong to a live upload. A phone
 * resumes its uploads for up to {@link RESUMABLE_UPLOAD_DAYS} days (P12); an
 * upload that belonged to an intent is aborted when the intent is swept, so this
 * is only the backstop for parts nothing points at.
 */
export const INCOMPLETE_UPLOAD_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** How long a phone's upload may stay unconfirmed while it waits for signal. */
export const RESUMABLE_UPLOAD_DAYS = 7;

export interface MaintenanceReport {
  provisioned: string[];
  intentsSwept: number;
  uploadsAborted: number;
  filesPurged: number;
  purgesDeferred: number;
  failures: { tenantId: string; step: string; message: string }[];
}

export async function runMediaMaintenance(options: {
  media: MediaStorage;
  now?: Date;
  /** Limit the run to these companies. */
  tenantIds?: readonly string[];
}): Promise<MaintenanceReport> {
  const { media } = options;
  const now = options.now ?? new Date();
  const platform = getPlatformDataSource();
  const report: MaintenanceReport = {
    provisioned: [],
    intentsSwept: 0,
    uploadsAborted: 0,
    filesPurged: 0,
    purgesDeferred: 0,
    failures: [],
  };
  const wanted = (tenantId: string) =>
    options.tenantIds === undefined || options.tenantIds.includes(tenantId);

  const attempt = async (tenantId: string, step: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      report.failures.push({
        tenantId,
        step,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const tenant of await platform.tenants.list()) {
    if (wanted(tenant.id) && (await platform.storage.find(tenant.id)) === undefined) {
      await attempt(tenant.id, 'provision', async () => {
        await provisionTenantStorage(media, tenant.id);
        report.provisioned.push(tenant.id);
      });
    }
  }

  for (const location of await platform.storage.listActive()) {
    const tenantId = location.tenantId;
    if (!wanted(tenantId) || location.provider !== media.provider) {
      continue;
    }
    const store = media.open(location.bucket);

    await attempt(tenantId, 'sweep', async () => {
      const expired = await withTenant(tenantId, (tx) => tx.files.listExpiredIntents(now));
      for (const intent of expired) {
        // Confirmation refuses an expired intent, so nothing can claim this one
        // between deleting its object and deleting it.
        if (intent.multipart !== null) {
          await store.abortMultipartUpload({
            key: intent.storageKey,
            uploadId: intent.multipart.uploadId,
          });
        }
        await store.delete([intent.storageKey]);
        if (await withTenant(tenantId, (tx) => tx.files.deleteIntent(intent.id))) {
          report.intentsSwept += 1;
        }
      }
    });

    await attempt(tenantId, 'abort', async () => {
      report.uploadsAborted += await store.abortIncompleteUploads(
        new Date(now.getTime() - INCOMPLETE_UPLOAD_MAX_AGE_MS),
      );
    });

    await attempt(tenantId, 'purge', async () => {
      const due = await withTenant(tenantId, (tx) => tx.files.listDueForPurge(now));
      for (const file of due) {
        // A deletion is refused while a submission names the file; this is the
        // last check before the bytes are gone for good.
        const referenced = await withTenant(tenantId, async (tx) => {
          if (await tx.files.isReferenced(file.id)) {
            await tx.files.restore(file.id, new Date(0));
            return true;
          }
          return false;
        });
        if (referenced) {
          report.purgesDeferred += 1;
          continue;
        }
        await store.delete(
          file.thumbnailKey === null ? [file.storageKey] : [file.storageKey, file.thumbnailKey],
        );
        if (await withTenant(tenantId, (tx) => tx.files.markPurged(file.id, now))) {
          report.filesPurged += 1;
        }
      }
    });
  }

  return report;
}
