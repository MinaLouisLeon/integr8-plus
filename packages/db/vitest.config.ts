import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Vitest does not read `.env` for server-side variables, and the integration
// suite is configured entirely by them. Workers inherit this process's
// environment, so loading it here is enough.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * Two suites, deliberately separated.
 *
 * `unit` runs anywhere and needs nothing. It is what `pnpm test` runs, and it
 * covers the pure parts of this package: the tenant guard, the LRU, migration
 * file parsing, configuration.
 *
 * `integration` needs a real Postgres and is what proves the phase. It runs
 * serially, because the suites apply migrations and truncate tables and two of
 * them at once would fight over the same schema.
 *
 * Both live under `src/`, so both are type-checked by `pnpm typecheck` and
 * linted by `pnpm lint`. The isolation suite is the most consequential code in
 * the repository; it does not get to sit outside the checks.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          environment: 'node',
          globalSetup: ['./src/testing/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
