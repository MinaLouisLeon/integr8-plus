import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirrors @integr8/db: the integration suite is configured entirely by
// environment variables, and vitest does not read `.env` for server-side ones.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * `unit` runs anywhere and covers the parts that need no database: key
 * handling, token minting and verification, the password policy, the token
 * formats. That is most of the security-critical surface of this package.
 *
 * `integration` exercises the services against real Postgres, where sessions,
 * rotation, invitations and impersonation actually live.
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
