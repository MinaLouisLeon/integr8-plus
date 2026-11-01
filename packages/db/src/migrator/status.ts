import { getPlatformDb } from '../connection.js';
import { loadMigrations } from './files.js';
import { compareMigrations, listMigrations, type MigrationStatus } from './runner.js';

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
 * Reads the migration history over the platform pool, which the API and the
 * worker already hold, rather than opening a connection of its own: the
 * readiness check calls it, and neither process has the owner's password. The
 * platform role may read the history and not write it (0058). It never creates
 * the history table, as the migrator does; a database with none has every
 * migration pending.
 */
export async function assertSchemaUpToDate(): Promise<SchemaCheck> {
  const { problems, aheadOfBuild } = checkSchema(
    compareMigrations(await appliedMigrations(), loadMigrations()),
  );

  if (problems.length > 0) {
    throw new SchemaOutOfDateError(problems);
  }
  return { aheadOfBuild };
}

async function appliedMigrations(): Promise<
  { version: string; name: string; checksum: string; applied_at: Date }[]
> {
  try {
    return await getPlatformDb()
      .selectFrom('schema_migrations')
      .select(['version', 'name', 'checksum', 'applied_at'])
      .orderBy('version')
      .execute();
  } catch (error) {
    // undefined_table: nothing has ever been migrated here.
    if ((error as { code?: unknown }).code === '42P01') {
      return [];
    }
    throw error;
  }
}
