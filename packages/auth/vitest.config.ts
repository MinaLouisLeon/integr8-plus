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
 *
 * `auth-server` runs the identity provider against a real Supabase Auth
 * container (P36): CI starts one; see `.github/workflows/ci.yml`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts', 'src/**/*.auth-server.test.ts'],
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
      {
        test: {
          name: 'auth-server',
          include: ['src/**/*.auth-server.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
