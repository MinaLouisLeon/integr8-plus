import { closeDatabase } from '@integr8/db';
import { buildServices } from '../composition.js';
import { assertProductionReady, loadApiConfig } from '../config.js';
import { createLogger } from '../http/logger.js';
import { flushSentry, initialiseSentry } from '../observability/sentry.js';
import { runMediaMaintenance } from '../media/maintenance.js';
import { runMetering } from '../media/metering.js';
import { runDunning } from '../billing/dunning.js';
import { runAiReconciliation } from '../ai/reconcile.js';
import { runSignupExpiry } from '../signup/expire.js';
import { runQualificationExpiry } from '../qualifications/expiry.js';
import { runDeadlineAlerts, runMaintenancePlans } from '../maintenance/tasks.js';
import { purgeDueTenants } from '../platform/purge.js';
import { runSyncMaintenance } from '../sync/maintenance.js';
import { buildJobHandlers } from './handlers.js';
import { runMaintenanceSteps } from './maintenance-steps.js';
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
  // The same refusal as the API. Without it the worker ran in production on
  // stand-in services the API had refused: with MEDIA_STORAGE=local it gave
  // every company a local storage record, and once R2 was configured those
  // companies could not reach their files at all.
  assertProductionReady(config);
  initialiseSentry(config);

  const logger = createLogger({
    level: config.APP_ENV === 'test' ? 'error' : 'info',
    service: 'integr8-worker',
    release: config.API_RELEASE,
  });

  // The worker uses the same service graph as the API: a job that sends an
  // invitation should go through the same code an HTTP request does.
  const services = await buildServices({ config });

  const worker = new Worker({ config, logger, handlers: buildJobHandlers(services, config) });

  // PDF documents (ADR-0001 D12): a worker that cannot print says so once, at
  // the start, and every other job runs as before. Documents asked for are
  // marked failed with the same reason.
  const printer = await services.pdf.status();
  if (printer.ok) {
    logger.info('PDF documents can be printed', { renderer: services.pdf.kind });
  } else {
    logger.error('PDF documents cannot be printed', { reason: printer.reason });
  }
  // E-invoicing's settings never stop the worker either; what is wrong is said once.
  for (const problem of services.eta.problems ?? []) {
    logger.warn(`E-invoicing: ${problem}`);
  }

  // Media housekeeping on a timer, alongside the queue. Several workers running
  // it at once is safe: every step is idempotent.
  let stopping = false;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let maintenanceRun: Promise<void>;
  const maintain = async (): Promise<void> => {
    // Each step on its own: one that fails is logged under its own name and
    // the rest still run (see runMaintenanceSteps).
    await runMaintenanceSteps(
      [
        {
          name: 'Media maintenance',
          run: async () => {
            const report = await runMediaMaintenance({ media: services.media });
            if (report.failures.length > 0) {
              logger.error('Media maintenance had failures', { ...report });
            } else {
              logger.info('Media maintenance finished', { ...report });
            }
          },
        },
        {
          name: 'Sync maintenance',
          run: async () => {
            const sync = await runSyncMaintenance({
              retentionDays: config.SYNC_LOG_RETENTION_DAYS,
            });
            if (sync.failures.length > 0) {
              logger.error('Sync maintenance had failures', { ...sync });
            } else {
              logger.info('Sync maintenance finished', { ...sync });
            }
          },
        },
        {
          // Companies whose cooling-off has passed (P15). On the timer rather
          // than on a queued job, because what has to be reliable is that a due
          // deletion eventually runs — including one whose job row went down
          // with the process that held it.
          name: 'Scheduled deletions',
          run: async () => {
            const purged = await purgeDueTenants({
              media: services.media,
              identity: services.identity,
              logger,
            });
            const done = purged.filter((result) => result.purged).length;
            if (purged.length > 0) {
              logger.info('Scheduled deletions finished', {
                companies: done,
                failed: purged.length - done,
              });
            }
          },
        },
        {
          // Metering (P16). Runs on the same timer but claims its turn in the
          // database, so it happens once a night rather than once a night per
          // worker, and every other tick is a single conditional update that
          // matches nothing.
          name: 'Metering',
          run: async () => {
            const metered = await runMetering({
              media: services.media,
              config,
              logger,
              workerId: worker.id,
            });
            if (metered.sampled > 0 || metered.retired > 0 || metered.failures.length > 0) {
              logger.info('Metering finished', {
                sampled: metered.sampled,
                reconciled: metered.reconciled,
                drifted: metered.drifted.length,
                retired: metered.retired,
                failures: metered.failures.length,
              });
            }
          },
        },
        {
          // Dunning (P17). Same timer, same turn-claiming. It only ever refuses
          // writes and posts banners — nothing in it deletes a customer's data.
          name: 'Dunning',
          run: async () => {
            const dunned = await runDunning({
              config,
              logger,
              workerId: worker.id,
              email: services.email,
            });
            if (
              dunned.trialsEnded > 0 ||
              dunned.remindersPosted > 0 ||
              dunned.madeReadOnly > 0 ||
              dunned.failures.length > 0
            ) {
              logger.info('Dunning finished', {
                trialsEnded: dunned.trialsEnded,
                remindersPosted: dunned.remindersPosted,
                madeReadOnly: dunned.madeReadOnly,
                failures: dunned.failures.length,
              });
            }
          },
        },
        {
          // Signups nobody verified (P18). Nothing was created for them, so
          // this only closes live tokens.
          name: 'Signup expiry',
          run: async () => {
            await runSignupExpiry({ logger, workerId: worker.id });
          },
        },
        {
          // Certificates expiring or lapsed (P26): warned once each, by email
          // and to the holder's phone. Same timer, same turn-claiming.
          name: 'Qualification expiry',
          run: async () => {
            const expiring = await runQualificationExpiry({
              config,
              logger,
              workerId: worker.id,
              email: services.email,
              push: services.push,
            });
            if (expiring.warned + expiring.lapsed + expiring.failures.length > 0) {
              logger.info('Qualification expiry finished', {
                companies: expiring.companies,
                warned: expiring.warned,
                lapsed: expiring.lapsed,
                passedOver: expiring.passedOver,
                failures: expiring.failures.length,
              });
            }
          },
        },
        {
          // Maintenance plans and contract renewals (P27): jobs made ahead of
          // their due dates, once a day. Same timer, same turn-claiming.
          name: 'Maintenance plans',
          run: async () => {
            const maintenance = await runMaintenancePlans({
              config,
              logger,
              workerId: worker.id,
              email: services.email,
              push: services.push,
            });
            if (
              maintenance.occurrences + maintenance.renewalAlerts + maintenance.failures.length >
              0
            ) {
              logger.info('Maintenance plans finished', {
                companies: maintenance.companies,
                jobsCreated: maintenance.jobsCreated,
                occurrences: maintenance.occurrences,
                skipped: maintenance.skipped,
                renewalAlerts: maintenance.renewalAlerts,
                failures: maintenance.failures.length,
              });
            }
          },
        },
        {
          // Response deadlines (P27): misses recorded and announced, warnings
          // sent, on every tick at most every ten minutes.
          name: 'Deadline alerts',
          run: async () => {
            const deadlines = await runDeadlineAlerts({
              config,
              logger,
              workerId: worker.id,
              email: services.email,
              push: services.push,
            });
            if (deadlines.warned + deadlines.missed + deadlines.failures.length > 0) {
              logger.info('Deadline alerts finished', {
                companies: deadlines.companies,
                warned: deadlines.warned,
                missed: deadlines.missed,
                failures: deadlines.failures.length,
              });
            }
          },
        },
        {
          // The assistant (docs/ai): slots held by requests that never settled,
          // proposals nobody confirmed, chats past their retention.
          name: 'Assistant reconciliation',
          run: async () => {
            const assistant = await runAiReconciliation({ config, logger, workerId: worker.id });
            if (
              assistant.reconciled > 0 ||
              assistant.expiredProposals > 0 ||
              assistant.sweptConversations > 0 ||
              assistant.failures.length > 0
            ) {
              logger.info('Assistant reconciliation finished', {
                reconciled: assistant.reconciled,
                charged: assistant.charged,
                released: assistant.released,
                expiredProposals: assistant.expiredProposals,
                sweptConversations: assistant.sweptConversations,
                failures: assistant.failures.length,
              });
            }
          },
        },
      ],
      logger,
    );
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
  await services.pdf.close();
  await closeDatabase();
  await flushSentry();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
