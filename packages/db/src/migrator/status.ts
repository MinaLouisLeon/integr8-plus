import pg from 'pg';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';
import { loadMigrations } from './files.js';
import { listMigrations, type MigrationStatus, Migrator } from './runner.js';

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

export interface SchemaCheck {
  /**
   * Migrations a newer release applied that this build has no file for, as
   * `0057_name`. Empty unless an earlier release was rolled back to; readiness
   * passes either way and shows them as a note.
   */
  aheadOfBuild: string[];
}

/**
 * Sorts migration states into what blocks readiness and what is only worth a
 * note. Pure, so the rule is tested without a database.
 *
 * Pending, edited and missing migrations block. Migrations from a newer
 * release do not: the expand/contract rule (docs/database/migrations.md)
 * promises the previous release runs on the newer schema, and a readiness
 * check that disagreed would keep `web` from starting after every rollback.
 * (A pending migration on a schema that is also ahead still blocks, because
 * it is still pending.)
 */
export function checkSchema(statuses: readonly MigrationStatus[]): {
  problems: string[];
  aheadOfBuild: string[];
} {
  return {
    problems: statuses
      .filter((entry) => entry.state !== 'applied' && entry.state !== 'ahead-of-build')
      .map((entry) => `${listMigrations([entry])} (${entry.state})`),
    aheadOfBuild: statuses
      .filter((entry) => entry.state === 'ahead-of-build')
      .map((entry) => listMigrations([entry])),
  };
}

/**
 * Throws unless every migration on disk has been applied.
 *
 * Worth calling at startup. A container that boots against a database missing
 * the table it is about to query fails on the first request that needs it,
 * which is a confusing error at a bad moment; this turns that into a clear one
 * before any traffic arrives.
 *
 * A database ahead of this build passes, and the result names what it has
 * that this build does not (`checkSchema`).
 *
 * Uses the owner connection, so it runs where migrations run — deploy scripts,
 * the API's readiness check, and the test suites of packages that depend on
 * this schema without owning it.
 */
export async function assertSchemaUpToDate(): Promise<SchemaCheck> {
  const client = new Client({
    connectionString: requireAdminConnectionString(loadDatabaseConfig()),
    application_name: 'integr8-schema-check',
  });
  await client.connect();

  try {
    const { problems, aheadOfBuild } = checkSchema(
      await new Migrator(client, loadMigrations()).status(),
    );

    if (problems.length > 0) {
      throw new SchemaOutOfDateError(problems);
    }
    return { aheadOfBuild };
  } finally {
    await client.end();
  }
}
