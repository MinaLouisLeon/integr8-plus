import type { IdentityProvider } from '@integr8/auth';
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
 *
 * Third, the people (P36): each member's sign-in account is deleted from Auth
 * unless they still belong to another company. Their ids are read before the
 * rows go and written to `identity_deletions`, because after the purge nothing
 * else remembers who they were; a delete that fails stays there and is tried
 * again on the next run.
 */

export const PURGE_QUEUE = 'tenant.purge';

export interface PurgeResult {
  tenantId: string;
  bucket: string | null;
  files: number;
  purged: boolean;
}

interface PurgeDeps {
  media: MediaStorage;
  identity: IdentityProvider;
  logger: Logger;
}

/**
 * Purges every company whose cooling-off has passed.
 *
 * Called on a schedule rather than per company, because the thing that has to
 * be reliable is that a due deletion eventually runs — including one whose job
 * row was lost with the process that held it.
 */
export async function purgeDueTenants(input: PurgeDeps & { now?: Date }): Promise<PurgeResult[]> {
  const platform = getPlatformDataSource();
  const due = await platform.lifecycle.due(input.now ?? new Date());
  const results: PurgeResult[] = [];

  for (const deletion of due) {
    results.push(await purgeOne(deletion.tenantId, input));
  }

  // Every run, not only one that purged something: this is the retry for a
  // delete that failed last time.
  await deleteOrphanedIdentities(input);

  return results;
}

export async function purgeOne(tenantId: string, input: PurgeDeps): Promise<PurgeResult> {
  const platform = getPlatformDataSource();

  // Before anything is removed: afterwards there is nothing left to read it from.
  const people = await platform.identityDeletions.membersOf(tenantId);

  const storage = await purgeTenantStorage(input.media, tenantId);
  input.logger.info('Company bucket emptied and removed', {
    tenantId,
    bucket: storage.bucket,
    files: storage.files,
  });

  await platform.lifecycle.purge(tenantId);
  input.logger.info('Company rows removed', { tenantId });

  await platform.identityDeletions.queue(people);
  const accounts = await deleteOrphanedIdentities(input);

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
    metadata: {
      bucket: storage.bucket,
      files: storage.files,
      people: people.length,
      signInAccountsDeleted: accounts.deleted,
      signInAccountsKept: accounts.kept,
      signInAccountsPending: accounts.failed,
    },
  });

  return { tenantId, bucket: storage.bucket, files: storage.files, purged: true };
}

export interface IdentityCleanup {
  /** Accounts deleted from Auth. */
  deleted: number;
  /** Queued, but the person belongs to a company again, so the account stays. */
  kept: number;
  /** Still pending: Auth refused or could not be reached. */
  failed: number;
}

/**
 * Works through `identity_deletions`: deletes each queued account that no
 * longer belongs to any company, and keeps the rest.
 *
 * Membership is checked at the moment of each delete, not when the id was
 * queued, so somebody invited to another company while a delete kept failing
 * keeps their account. A `404` from Auth counts as done.
 */
export async function deleteOrphanedIdentities(input: {
  identity: IdentityProvider;
  logger: Logger;
}): Promise<IdentityCleanup> {
  const deletions = getPlatformDataSource().identityDeletions;
  const outcome: IdentityCleanup = { deleted: 0, kept: 0, failed: 0 };

  for (const pending of await deletions.pending()) {
    if (await deletions.hasMembership(pending.userId)) {
      await deletions.markDone(pending.userId);
      outcome.kept += 1;
      continue;
    }
    try {
      await input.identity.deleteIdentity(pending.userId);
      await deletions.markDone(pending.userId);
      outcome.deleted += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await deletions.markFailed(pending.userId, reason);
      outcome.failed += 1;
      // The id is not logged: on its own it says nothing, and the row says it.
      input.logger.error('Sign-in account not deleted; will retry on the next purge run', {
        reason,
        attempts: pending.attempts + 1,
      });
    }
  }

  return outcome;
}
