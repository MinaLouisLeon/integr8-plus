import { getPlatformDataSource, withTenant } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../http/logger.js';
import { captureException } from '../observability/sentry.js';
import { fetchBucketAnalytics, fetchBucketOperations } from './cloudflare-usage.js';
import { allowanceFor } from './quota.js';
import type { MediaStorage } from './storage.js';

/**
 * The nightly metering run (P16).
 *
 * Three things happen once a day, and they are separate because they fail
 * separately: taking a sample of what every company is using, checking the
 * ledger against what Cloudflare bills from, and taking media past its
 * retention window.
 *
 * None of them is a queued job. There is no cron in this system and no
 * scheduler process — the worker runs housekeeping on a timer and several
 * workers run at once — so each claims its turn in `scheduled_task_runs` and
 * exactly one worker's conditional update wins. The claim is on the *start*, so
 * a run that dies holding its turn is retried on the next tick after the
 * interval rather than never.
 */

/** How far apart a task's runs must be. Once a day, judged from the last start. */
const DAILY = { hours: 20 } as const;

export const SAMPLE_TASK = 'storage.sample';
export const RECONCILE_TASK = 'storage.reconcile';
export const RETENTION_TASK = 'storage.retention';

/**
 * How far the ledger and Cloudflare may differ before it is worth waking
 * somebody.
 *
 * Both a ratio and a floor, because neither alone is usable: one percent of a
 * trial company is a few megabytes and would page on a single unswept upload,
 * and a flat ten megabytes on a company storing terabytes would never fire.
 * A result is drift only when it clears both.
 */
export const DRIFT_RATIO = 0.01;
export const DRIFT_FLOOR_BYTES = 10 * 1024 * 1024;

export interface MeteringReport {
  sampled: number;
  reconciled: number;
  drifted: { tenantId: string; slug: string; ledgerBytes: number; cloudflareBytes: number }[];
  retired: number;
  failures: { tenantId: string; step: string; message: string }[];
}

export interface MeteringOptions {
  media: MediaStorage;
  config: ApiConfig;
  logger: Logger;
  workerId: string;
  now?: Date;
  /** Skips the turn-claiming, for the CLI and for tests. */
  force?: boolean;
}

export async function runMetering(options: MeteringOptions): Promise<MeteringReport> {
  const report: MeteringReport = {
    sampled: 0,
    reconciled: 0,
    drifted: [],
    retired: 0,
    failures: [],
  };

  const metering = getPlatformDataSource().metering;
  const claim = async (task: string) =>
    options.force === true || (await metering.claimTask(task, DAILY, options.workerId));

  // The sample and the reconciliation are one pass over the companies, because
  // both need the same two reads and the second is a call to Cloudflare.
  if (await claim(SAMPLE_TASK)) {
    try {
      await sampleAndReconcile(options, report);
      await metering.finishTask(SAMPLE_TASK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await metering.finishTask(SAMPLE_TASK, message);
      throw error;
    }
  }

  if (await claim(RETENTION_TASK)) {
    try {
      report.retired = await applyRetention(options, report);
      await metering.finishTask(RETENTION_TASK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await metering.finishTask(RETENTION_TASK, message);
      throw error;
    }
  }

  return report;
}

async function sampleAndReconcile(options: MeteringOptions, report: MeteringReport): Promise<void> {
  const platform = getPlatformDataSource();
  const now = options.now ?? new Date();
  const day = dayOf(now);

  for (const tenant of await platform.tenants.list()) {
    try {
      const usage = await withTenant(tenant.id, (tx) => tx.files.usage());
      const rule = await allowanceFor(tenant.plan, now.getTime());

      const analytics = await cloudflareFor(options, tenant.id);

      await platform.metering.recordSample({
        tenantId: tenant.id,
        sampledOn: day,
        bytes: usage.totalBytes,
        objects: usage.totalObjects,
        byCategory: Object.fromEntries(
          usage.categories.map((category) => [category.category, category.bytes]),
        ),
        allowanceBytes: rule.storageBytes,
        classAOperations: analytics?.operations?.classA ?? null,
        classBOperations: analytics?.operations?.classB ?? null,
      });
      report.sampled += 1;

      // The reconciliation, from the same reads.
      if (analytics === undefined) {
        await platform.metering.recordReconciliation({
          tenantId: tenant.id,
          ledgerBytes: usage.totalBytes,
          ledgerObjects: usage.totalObjects,
          cloudflareBytes: null,
          cloudflareObjects: null,
          cloudflareSampledAt: null,
          status: 'unavailable',
          note: analyticsUnavailableReason(options),
        });
        continue;
      }

      const cloudflareBytes = analytics.storage.payloadSize;
      const drift = Math.abs(usage.totalBytes - cloudflareBytes);
      const drifted =
        drift > DRIFT_FLOOR_BYTES &&
        drift > Math.max(usage.totalBytes, cloudflareBytes) * DRIFT_RATIO;

      await platform.metering.recordReconciliation({
        tenantId: tenant.id,
        ledgerBytes: usage.totalBytes,
        ledgerObjects: usage.totalObjects,
        cloudflareBytes,
        cloudflareObjects: analytics.storage.objectCount,
        cloudflareSampledAt: analytics.storage.sampledAt,
        status: drifted ? 'drifted' : 'matched',
      });
      report.reconciled += 1;

      if (drifted) {
        report.drifted.push({
          tenantId: tenant.id,
          slug: tenant.slug,
          ledgerBytes: usage.totalBytes,
          cloudflareBytes,
        });
        await raiseDrift(tenant, usage.totalBytes, cloudflareBytes, options.logger);
      }
    } catch (error) {
      report.failures.push({
        tenantId: tenant.id,
        step: 'sample',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * What Cloudflare says about a bucket: what it holds, and what it cost.
 *
 * `undefined` when there is nothing to ask — local storage in development, no
 * analytics token, or a company whose bucket Cloudflare has not sampled yet.
 * That is recorded as `unavailable` rather than as a match, because "we could
 * not check" and "we checked and it agreed" are different facts and only one of
 * them is reassuring.
 */
async function cloudflareFor(
  options: MeteringOptions,
  tenantId: string,
): Promise<
  | {
      storage: Awaited<ReturnType<typeof fetchBucketAnalytics>> & object;
      operations: Awaited<ReturnType<typeof fetchBucketOperations>>;
    }
  | undefined
> {
  const { config, media } = options;
  const accountId = config.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = config.CLOUDFLARE_API_TOKEN;
  if (media.provider !== 'r2' || accountId === undefined || apiToken === undefined) {
    return undefined;
  }

  const location = await getPlatformDataSource().storage.find(tenantId);
  // Nothing to ask about a bucket that was never made or has been purged. The
  // optional chain covers both: an absent row gives `undefined`, which is not
  // null, so it takes the same exit as a purged one.
  if (location?.purgedAt !== null) {
    return undefined;
  }

  const now = options.now ?? new Date();
  const storage = await fetchBucketAnalytics({
    accountId,
    apiToken,
    bucket: location.bucket,
    now,
  });
  if (storage === undefined) {
    return undefined;
  }

  // A day's operations, so the figure on the sample is a day's cost rather than
  // a running total nobody can difference.
  const operations = await fetchBucketOperations({
    accountId,
    apiToken,
    bucket: location.bucket,
    since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    until: now,
  });

  return { storage, operations };
}

function analyticsUnavailableReason(options: MeteringOptions): string {
  if (options.media.provider !== 'r2') {
    return `Storage is ${options.media.provider}, so there is nothing at Cloudflare to compare against.`;
  }
  if (options.config.CLOUDFLARE_API_TOKEN === undefined) {
    return 'CLOUDFLARE_API_TOKEN is not set, so the ledger cannot be audited.';
  }
  return 'Cloudflare has no sample for this bucket yet.';
}

/**
 * Raises a drift, to the two places P16 says it goes.
 *
 * Sentry is where an engineer already looks, and the platform audit log is the
 * permanent record naming the company and the numbers — the dashboard reads the
 * reconciliation table itself. Sentry can only carry exceptions today, so the
 * drift is thrown and caught here rather than reported as a message; the
 * alternative was widening the Sentry wrapper for one caller.
 */
async function raiseDrift(
  tenant: { id: string; slug: string },
  ledgerBytes: number,
  cloudflareBytes: number,
  logger: Logger,
): Promise<void> {
  const message = `Storage drift for ${tenant.slug}: the ledger says ${String(ledgerBytes)} bytes, Cloudflare says ${String(cloudflareBytes)}.`;

  logger.error('Storage drift', {
    tenantId: tenant.id,
    slug: tenant.slug,
    ledgerBytes,
    cloudflareBytes,
  });

  captureException(new Error(message), {
    tenantId: tenant.id,
    slug: tenant.slug,
    kind: 'storage_drift',
  });

  await getPlatformDataSource().platformAudit.append({
    platformUserId: null,
    actorLabel: 'metering',
    action: 'storage.drift_detected',
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    targetKind: 'tenant',
    targetId: tenant.id,
    metadata: { ledgerBytes, cloudflareBytes, driftBytes: ledgerBytes - cloudflareBytes },
  });
}

/**
 * Takes media past its plan's retention window.
 *
 * It soft-deletes rather than purging: the file lands in the same thirty-day
 * restore window a person's delete uses, and the existing maintenance sweep
 * removes the bytes at the end of it. Automatic deletion of a customer's data
 * stays reversible for a month, and there is exactly one path that removes
 * bytes rather than two.
 *
 * A file still referenced by a submission is taken too. That is what a
 * retention window means — the record ages out — and a policy that quietly
 * skipped anything in use would delete nothing at all, which is worse than
 * either honest answer. The window is per plan and starts at null, so nothing
 * is deleted anywhere until somebody sets one.
 */
async function applyRetention(options: MeteringOptions, report: MeteringReport): Promise<number> {
  const platform = getPlatformDataSource();
  const now = options.now ?? new Date();
  let retired = 0;

  for (const tenant of await platform.tenants.list()) {
    const rule = await allowanceFor(tenant.plan, now.getTime());
    if (rule.retentionDays === null) {
      continue;
    }

    const before = new Date(now.getTime() - rule.retentionDays * 24 * 60 * 60 * 1000);
    try {
      const taken = await withTenant(tenant.id, (tx) =>
        tx.files.retireOlderThan(before, {
          purgeAfter: new Date(
            now.getTime() + options.config.MEDIA_RESTORE_DAYS * 24 * 60 * 60 * 1000,
          ),
          limit: 500,
        }),
      );
      retired += taken;

      if (taken > 0) {
        options.logger.info('Retention applied', {
          tenantId: tenant.id,
          slug: tenant.slug,
          retentionDays: rule.retentionDays,
          files: taken,
        });
      }
    } catch (error) {
      report.failures.push({
        tenantId: tenant.id,
        step: 'retention',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return retired;
}

/** `YYYY-MM-DD` in UTC. A day is a day everywhere, not in the worker's timezone. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}
