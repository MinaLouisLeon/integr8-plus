import { closeDatabase } from '@integr8/db';
import { buildServices } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { createLogger } from '../http/logger.js';
import { flushSentry, initialiseSentry } from '../observability/sentry.js';
import { jobHandlers } from './handlers.js';
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
  await buildServices({ config });

  const worker = new Worker({ config, logger, handlers: jobHandlers });

  const shutdown = (signal: string): void => {
    logger.info('Worker shutting down', { signal });
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
  await closeDatabase();
  await flushSentry();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
