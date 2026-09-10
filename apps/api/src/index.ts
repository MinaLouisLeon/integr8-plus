import { closeDatabase } from '@integr8/db';
import { buildAppInfo } from './app-info.js';
import { buildServices } from './composition.js';
import { assertProductionReady, loadApiConfig } from './config.js';
import { createLogger } from './http/logger.js';
import { flushSentry, initialiseSentry } from './observability/sentry.js';
import { allRoutes } from './routes/index.js';
import { buildServer } from './server.js';

/**
 * The API process.
 *
 * Long-lived containers, not serverless functions. That is a locked decision
 * from P02 and this is where it becomes concrete: the process holds a warm
 * connection pool per tenant and an in-memory rate-limit short circuit, neither
 * of which survives a cold start.
 */

async function main(): Promise<void> {
  const config = loadApiConfig();
  assertProductionReady(config);
  initialiseSentry(config);

  const info = buildAppInfo();
  const logger = createLogger({
    level: config.APP_ENV === 'test' ? 'error' : 'info',
    service: 'integr8-api',
    release: config.API_RELEASE,
  });

  const services = await buildServices({ config });
  const app = buildServer({ config, services, routes: allRoutes(config), logger });

  await app.listen({ port: config.PORT, host: config.HOST });

  logger.info('API listening', {
    app: info.id,
    version: info.version,
    environment: config.APP_ENV,
    port: config.PORT,
    minSupportedClient: config.API_MIN_SUPPORTED_CLIENT,
  });

  /**
   * Shutdown, in the order that loses nothing.
   *
   * Fastify stops accepting connections and waits for in-flight requests, so a
   * deploy does not cut somebody off mid-save. Only then do the pools close,
   * and only then does Sentry flush — a crash that reports nothing is a crash
   * nobody can fix.
   */
  const shutdown = (signal: string): void => {
    logger.info('Shutting down', { signal });

    void (async () => {
      try {
        await app.close();
        await closeDatabase();
        await flushSentry();
        process.exit(0);
      } catch (error) {
        logger.error('Shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  // Before the logger exists there is nowhere structured to write, and a
  // startup failure has to be readable in a container log either way.
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
