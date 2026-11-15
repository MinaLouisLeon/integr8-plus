import { getPlatformDataSource } from '@integr8/db';
import type { Logger } from '../http/logger.js';

/**
 * Keeps the year partitions made ahead of time, once a day (P41).
 *
 * The tables that grow forever are split by UTC year. A row whose year has no
 * partition still goes in, into the table's default partition, but every year
 * made late means moving rows out of it under a lock. Making next year's
 * partitions months early means that never happens in normal use; the same
 * call also gives their own year to rows an import put in the default
 * partition.
 *
 * Same shape as the other nightly runs: a turn claimed in
 * `scheduled_task_runs`, so several workers produce one run.
 */

export const YEAR_PARTITIONS_TASK = 'partitions.ensure';

const DAILY = { hours: 20 } as const;

export async function runYearPartitions(options: {
  logger: Pick<Logger, 'info'>;
  workerId: string;
  force?: boolean;
}): Promise<number> {
  const platform = getPlatformDataSource();
  const claimed =
    options.force === true ||
    (await platform.metering.claimTask(YEAR_PARTITIONS_TASK, DAILY, options.workerId));
  if (!claimed) {
    return 0;
  }

  try {
    const made = await platform.housekeeping.ensureYearPartitions();
    await platform.metering.finishTask(YEAR_PARTITIONS_TASK);
    if (made > 0) {
      options.logger.info('Year partitions made', { made });
    }
    return made;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platform.metering.finishTask(YEAR_PARTITIONS_TASK, message);
    throw error;
  }
}
