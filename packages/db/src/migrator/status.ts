import pg from 'pg';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';
import { loadMigrations } from './files.js';
import { Migrator } from './runner.js';

const { Client } = pg;

export class SchemaOutOfDateError extends Error {
  constructor(readonly pending: readonly string[]) {
    super(
      [
        'The database schema is behind the migrations in this build:',
        ...pending.map((entry) => `  - ${entry}`),
        '',
        'Run: pnpm --filter @integr8/db db up',
      ].join('\n'),
    );
    this.name = 'SchemaOutOfDateError';
  }
}

/**
 * Throws unless every migration on disk has been applied.
 *
 * Worth calling at startup. A container that boots against a database missing
 * the table it is about to query fails on the first request that needs it,
 * which is a confusing error at a bad moment; this turns that into a clear one
 * before any traffic arrives.
 *
 * Uses the owner connection, so it runs where migrations run — deploy scripts,
 * the API's readiness check, and the test suites of packages that depend on
 * this schema without owning it.
 */
export async function assertSchemaUpToDate(): Promise<void> {
  const client = new Client({
    connectionString: requireAdminConnectionString(loadDatabaseConfig()),
    application_name: 'integr8-schema-check',
  });
  await client.connect();

  try {
    const statuses = await new Migrator(client, loadMigrations()).status();
    const problems = statuses
      .filter((entry) => entry.state !== 'applied')
      .map((entry) => `${entry.version}_${entry.name} (${entry.state})`);

    if (problems.length > 0) {
      throw new SchemaOutOfDateError(problems);
    }
  } finally {
    await client.end();
  }
}
