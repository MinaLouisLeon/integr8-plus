import { closeDatabase } from '@integr8/db';
import { buildServices } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { createLogger } from '../http/logger.js';
import { flushSentry, initialiseSentry } from '../observability/sentry.js';
import { runMediaMaintenance } from '../media/maintenance.js';
import { purgeDueTenants } from '../platform/purge.js';
import { runSyncMaintenance } from '../sync/maintenance.js';
import { buildJobHandlers } from './handlers.js';
import { Worker } from './worker.js';

/**
 * The worker process.
 *
 * A separate process from the API, not a thread inside it. A job that pins a
 * core or leaks memory then degrades background work rather than every request,
 * and the two scale independently — a queue backlog is a reason to add workers,
 * not web containers.
 */
async function main(): Promise<void> {
  const config = loadApiConfig();
  initialiseSentry(config);

  const logger = createLogger({
    level: config.APP_ENV === 'test' ? 'error' : 'info',
    service: 'integr8-worker',
    release: config.API_RELEASE,
  });

  // The worker uses the same service graph as the API: a job that sends an
  // invitation should go through the same code an HTTP request does.
  const services = await buildServices({ config });

  const worker = new Worker({ config, logger, handlers: buildJobHandlers(services) });

  // Media housekeeping on a timer, alongside the queue. Several workers running
  // it at once is safe: every step is idempotent.
  let stopping = false;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let maintenanceRun: Promise<void>;
  const maintain = async (): Promise<void> => {
    try {
      const report = await runMediaMaintenance({ media: services.media });
      if (report.failures.length > 0) {
        logger.error('Media maintenance had failures', { ...report });
      } else {
        logger.info('Media maintenance finished', { ...report });
      }
      const sync = await runSyncMaintenance({ retentionDays: config.SYNC_LOG_RETENTION_DAYS });
      if (sync.failures.length > 0) {
        logger.error('Sync maintenance had failures', { ...sync });
      } else {
        logger.info('Sync maintenance finished', { ...sync });
      }

      // Companies whose cooling-off has passed (P15). On the timer rather than
      // on a queued job, because what has to be reliable is that a due deletion
      // eventually runs — including one whose job row went down with the
      // process that held it.
      const purged = await purgeDueTenants({ media: services.media, logger });
      if (purged.length > 0) {
        logger.info('Scheduled deletions completed', { companies: purged.length });
      }
    } catch (error) {
      logger.error('Media maintenance failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!stopping) {
      maintenanceTimer = setTimeout(() => {
        maintenanceRun = maintain();
      }, config.MEDIA_MAINTENANCE_INTERVAL_SECONDS * 1000);
    }
  };
  maintenanceRun = maintain();

  const shutdown = (signal: string): void => {
    logger.info('Worker shutting down', { signal });
    stopping = true;
    clearTimeout(maintenanceTimer);
    worker.stop();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  // `run` returns once `stop` has been called and the batch in flight has
  // finished, so a deploy never kills a job halfway.
  await worker.run();
  await maintenanceRun;
  await closeDatabase();
  await flushSentry();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
