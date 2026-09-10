import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * `unit` covers the request pipeline's pure parts — the error model, version
 * negotiation, request fingerprints, log redaction, retry backoff, and the
 * OpenAPI document itself. None needs a database, so the contract is checked on
 * every commit.
 *
 * `integration` drives real HTTP through the assembled server against real
 * Postgres, which is where idempotency and the request id actually have to
 * hold.
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
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
