import { getPlatformDataSource, type HousekeepingReport } from '@integr8/db';
import type { Logger } from '../http/logger.js';

/**
 * Deletes rows three tables no longer need, once a night.
 *
 * - **Rate-limit counters** a day after their window started. The longest
 *   window is an hour; a counter whose window has passed counts nothing.
 * - **Idempotency records** once past their own `expires_at`. By then a retry
 *   with the same key takes the row over rather than replaying it, so the row
 *   is already as good as gone. Each record carries its own expiry (24 hours
 *   for a request, `SYNC_REPLAY_DAYS` for a phone's change), and that is what
 *   is honoured, not one age for all.
 * - **Login attempts** after 90 days. Kept that long because they are what
 *   somebody reconstructs an attack from; the lockout itself looks back fifteen
 *   minutes.
 *
 * Same shape as the other nightly runs: a turn claimed in
 * `scheduled_task_runs`, so several workers produce one run.
 */

export const TABLE_HOUSEKEEPING_TASK = 'housekeeping.tables';

const DAILY = { hours: 20 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a rate-limit counter is kept after its window started. */
export const RATE_LIMIT_RETENTION_MS = DAY_MS;

/** How long a login attempt is kept. */
export const LOGIN_ATTEMPT_RETENTION_MS = 90 * DAY_MS;

export async function runTableHousekeeping(options: {
  logger: Pick<Logger, 'info'>;
  workerId: string;
  now?: Date;
  force?: boolean;
}): Promise<HousekeepingReport> {
  const platform = getPlatformDataSource();
  const nothing = { rateLimitBuckets: 0, idempotencyKeys: 0, loginAttempts: 0 };

  const claimed =
    options.force === true ||
    (await platform.metering.claimTask(TABLE_HOUSEKEEPING_TASK, DAILY, options.workerId));
  if (!claimed) {
    return nothing;
  }

  const now = options.now ?? new Date();
  try {
    const report = await platform.housekeeping.sweep({
      rateLimitWindowsBefore: new Date(now.getTime() - RATE_LIMIT_RETENTION_MS),
      idempotencyExpiredBefore: now,
      loginAttemptsBefore: new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS),
    });
    await platform.metering.finishTask(TABLE_HOUSEKEEPING_TASK);

    if (report.rateLimitBuckets + report.idempotencyKeys + report.loginAttempts > 0) {
      options.logger.info('Table housekeeping finished', { ...report });
    }
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platform.metering.finishTask(TABLE_HOUSEKEEPING_TASK, message);
    throw error;
  }
}
