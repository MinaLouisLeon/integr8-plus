import type { Logger } from '../http/logger.js';

/** One piece of the worker's housekeeping, run on the maintenance timer. */
export interface MaintenanceStep {
  /** Names the step in the log line written when it fails. */
  name: string;
  run: () => Promise<void>;
}

/**
 * Runs each housekeeping step on its own, in order.
 *
 * The steps used to share one try/catch, so the first one to throw skipped
 * every step after it, on every tick. A purge that kept failing silenced
 * certificate-expiry warnings, planned maintenance jobs and deadline alerts for
 * every company, and the log said only "Media maintenance failed". Now a
 * failure is logged under the step's own name and the rest still run.
 *
 * Returns the names of the steps that failed.
 */
export async function runMaintenanceSteps(
  steps: readonly MaintenanceStep[],
  logger: Pick<Logger, 'error'>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failed.push(step.name);
      logger.error(`${step.name} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failed;
}
