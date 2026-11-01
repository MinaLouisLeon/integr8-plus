import type { Client } from 'pg';
import type { MigrationFile } from './files.js';

/**
 * The migration runner.
 *
 * Properties it is built to have, in the order they matter:
 *
 * - **Ordered and recorded.** `schema_migrations` is the only source of truth
 *   for what has run. There is no "push the schema and hope".
 * - **Checksummed.** Editing a migration that has already been applied is
 *   caught, not discovered later as a difference between staging and
 *   production.
 * - **Locked.** A session-level advisory lock means two CI runs deploying at
 *   once queue rather than interleave.
 * - **Reversible.** Every migration has a `down`, and `down` is exercised in CI
 *   rather than written and never run.
 * - **Tolerant of a newer schema.** Rolling a release back to the previous image
 *   leaves the newer release's migrations applied, with no file for them in the
 *   older build. As long as they are all newer than anything this build knows,
 *   that is a schema ahead of the build, not a broken one: `up` has nothing to
 *   do, `status` says so, and readiness passes, so the previous release runs on
 *   it. That is the promise expand/contract makes (docs/database/migrations.md).
 *
 * It talks to `pg` directly rather than through Kysely because a migration file
 * holds many statements, and Kysely's parameterised protocol permits one per
 * round trip. The simple query protocol used here also wraps a multi-statement
 * string in a single implicit transaction, which is what a migration wants.
 */

/**
 * Fixed key for `pg_advisory_lock`. Arbitrary but stable: changing it would let
 * an old deploy and a new one hold different locks and run concurrently.
 */
const ADVISORY_LOCK_KEY = 8_675_309;

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  applied_by: string;
  execution_ms: number;
}

export interface MigrationStatus {
  version: string;
  name: string;
  /**
   * `ahead-of-build` is an applied migration this build has no file for and
   * that is newer than every file it has: a newer release ran it, and this
   * build is an earlier one. `missing-file` is the same absence anywhere else,
   * which no rollback explains.
   */
  state: 'applied' | 'pending' | 'missing-file' | 'checksum-mismatch' | 'ahead-of-build';
  appliedAt?: Date;
}

export interface MigrationOutcome {
  version: string;
  name: string;
  direction: 'up' | 'down';
  durationMs: number;
}

export class MigrationChecksumError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      [
        'Applied migrations no longer match the files on disk:',
        ...problems.map((problem) => `  - ${problem}`),
        '',
        'A migration that has run is immutable. To change what it did, write a new migration.',
      ].join('\n'),
    );
    this.name = 'MigrationChecksumError';
  }
}

/**
 * Compares the version table with the files this build carries.
 *
 * Pure, so the classification that decides whether a rolled-back release may
 * start is tested without a database. An applied migration with no file counts
 * as `ahead-of-build` only when it is newer than the newest file here: a gap in
 * the middle means a file was deleted or renamed, and a build with no files at
 * all is a packaging mistake, not an earlier release.
 */
export function compareMigrations(
  applied: readonly Pick<AppliedMigration, 'version' | 'name' | 'checksum' | 'applied_at'>[],
  files: readonly Pick<MigrationFile, 'version' | 'name' | 'checksum'>[],
): MigrationStatus[] {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const onDisk = new Map(files.map((migration) => [migration.version, migration]));
  const newestFile = newestVersion(files);

  const versions = [...new Set([...appliedByVersion.keys(), ...onDisk.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );

  return versions.map((version): MigrationStatus => {
    const file = onDisk.get(version);
    const row = appliedByVersion.get(version);

    if (row === undefined) {
      return { version, name: file?.name ?? '(unknown)', state: 'pending' };
    }
    if (file === undefined) {
      return {
        version,
        name: row.name,
        state: isNewer(version, newestFile) ? 'ahead-of-build' : 'missing-file',
        appliedAt: row.applied_at,
      };
    }
    return {
      version,
      name: file.name,
      state: file.checksum === row.checksum ? 'applied' : 'checksum-mismatch',
      appliedAt: row.applied_at,
    };
  });
}

/**
 * What stops this build from migrating or rolling back, one line each.
 *
 * A schema ahead of the build is not on the list by itself. It is when this
 * build also has a migration still to apply: then the newer release that ran
 * did not contain this one's migrations, so this build is not its predecessor,
 * and nothing can say what applying the missing one on top of it would do.
 */
export function migrationProblems(statuses: readonly MigrationStatus[]): string[] {
  const ahead = statuses.filter((entry) => entry.state === 'ahead-of-build');
  const problems: string[] = [];

  for (const entry of statuses) {
    const label = `${entry.version}_${entry.name}`;
    if (entry.state === 'missing-file') {
      problems.push(`${label} was applied but its file is gone`);
    } else if (entry.state === 'checksum-mismatch') {
      problems.push(`${label} was applied but its file has changed since`);
    } else if (entry.state === 'pending' && ahead.length > 0) {
      problems.push(
        `${label} has not been applied, yet the database already has ${listMigrations(ahead)} from a newer release that did not include it`,
      );
    }
  }

  return problems;
}

/** `0057_a, 0058_b`, for messages. */
export function listMigrations(entries: readonly { version: string; name: string }[]): string {
  return entries.map((entry) => `${entry.version}_${entry.name}`).join(', ');
}

function newestVersion(files: readonly { version: string }[]): string | undefined {
  return files
    .map((file) => file.version)
    .sort((a, b) => a.localeCompare(b))
    .at(-1);
}

function isNewer(version: string, newestFile: string | undefined): boolean {
  return newestFile !== undefined && version.localeCompare(newestFile) > 0;
}

export class Migrator {
  constructor(
    private readonly client: Client,
    private readonly migrations: readonly MigrationFile[],
  ) {}

  /**
   * Creates `schema_migrations` if it is absent.
   *
   * RLS is enabled on it with no policy, so it obeys the same rule as every
   * other table in `public` and the schema-invariant suite needs no exception
   * list for it.
   */
  async ensureVersionTable(): Promise<void> {
    await this.client.query(`
      create table if not exists schema_migrations (
        version       text        primary key,
        name          text        not null,
        checksum      text        not null,
        applied_at    timestamptz not null default now(),
        applied_by    text        not null default current_user,
        execution_ms  integer     not null
      );

      comment on table schema_migrations is
        'Applied migrations. Written only by the migration runner in @integr8/db.';

      alter table schema_migrations enable row level security;
    `);
  }

  async applied(): Promise<AppliedMigration[]> {
    const result = await this.client.query<AppliedMigration>(
      'select version, name, checksum, applied_at, applied_by, execution_ms from schema_migrations order by version',
    );
    return result.rows;
  }

  async status(): Promise<MigrationStatus[]> {
    await this.ensureVersionTable();
    return compareMigrations(await this.applied(), this.migrations);
  }

  /**
   * Applied migrations from a newer release that this build has no file for.
   *
   * Empty except after rolling back to an earlier image. The CLI prints them
   * as a warning when `up` has nothing to do because of them.
   */
  async aheadOfBuild(): Promise<MigrationStatus[]> {
    return (await this.status()).filter((entry) => entry.state === 'ahead-of-build');
  }

  /**
   * Throws if any applied migration differs from its file, or has no file and
   * is not explained by a newer release (see `migrationProblems`).
   *
   * Called before every `up`, so an edited migration blocks a deploy rather
   * than producing two databases that quietly disagree.
   */
  async verify(): Promise<void> {
    const problems = migrationProblems(await this.status());

    if (problems.length > 0) {
      throw new MigrationChecksumError(problems);
    }
  }

  /**
   * Applies every pending migration, or stops after `to`.
   *
   * On a schema ahead of this build nothing is ever pending (`verify` refuses
   * the one case where something would be), so this returns an empty list and
   * the earlier release starts on the newer schema.
   */
  async up(options: { to?: string } = {}): Promise<MigrationOutcome[]> {
    return this.#locked(async () => {
      await this.ensureVersionTable();
      await this.verify();

      const applied = new Set((await this.applied()).map((row) => row.version));
      const outcomes: MigrationOutcome[] = [];

      for (const migration of this.migrations) {
        if (applied.has(migration.version)) {
          continue;
        }
        if (options.to !== undefined && migration.version > options.to) {
          break;
        }
        outcomes.push(await this.#applyUp(migration));
      }

      return outcomes;
    });
  }

  /**
   * Rolls back applied migrations, newest first.
   *
   * `steps` rolls back that many; `to` rolls back everything above that
   * version, leaving it applied. With neither, exactly one is rolled back —
   * the cautious default for a command usually typed in a hurry.
   */
  async down(options: { to?: string; steps?: number } = {}): Promise<MigrationOutcome[]> {
    return this.#locked(async () => {
      await this.ensureVersionTable();
      await this.verify();

      const applied = (await this.applied()).sort((a, b) => b.version.localeCompare(a.version));
      const byVersion = new Map(this.migrations.map((migration) => [migration.version, migration]));

      const floor = options.to;
      const targets =
        floor === undefined
          ? applied.slice(0, options.steps ?? 1)
          : applied.filter((row) => row.version > floor);

      // Every target is checked before any is rolled back, so a refusal leaves
      // the schema as it was rather than part of the way down.
      const newestFile = newestVersion(this.migrations);
      const plan = targets.map((row) => {
        const migration = byVersion.get(row.version);
        if (migration !== undefined) {
          return migration;
        }
        if (isNewer(row.version, newestFile)) {
          throw new Error(
            [
              `Cannot roll back ${row.version}_${row.name}: a newer release applied it, and this build has no down file for it.`,
              'Run "down" from that release instead, or leave it applied: this build runs on the newer schema.',
            ].join('\n'),
          );
        }
        throw new Error(
          `Cannot roll back ${row.version}_${row.name}: its file is not on disk. Restore it from git first.`,
        );
      });

      const outcomes: MigrationOutcome[] = [];
      for (const migration of plan) {
        outcomes.push(await this.#applyDown(migration));
      }

      return outcomes;
    });
  }

  async #applyUp(migration: MigrationFile): Promise<MigrationOutcome> {
    const started = performance.now();

    await this.#maybeTransactional(migration.useTransaction, async () => {
      await this.client.query(migration.up);
      await this.client.query(
        'insert into schema_migrations (version, name, checksum, execution_ms) values ($1, $2, $3, $4)',
        [
          migration.version,
          migration.name,
          migration.checksum,
          Math.round(performance.now() - started),
        ],
      );
    });

    return {
      version: migration.version,
      name: migration.name,
      direction: 'up',
      durationMs: Math.round(performance.now() - started),
    };
  }

  async #applyDown(migration: MigrationFile): Promise<MigrationOutcome> {
    const started = performance.now();

    await this.#maybeTransactional(migration.useTransaction, async () => {
      await this.client.query(migration.down);
      await this.client.query('delete from schema_migrations where version = $1', [
        migration.version,
      ]);
    });

    return {
      version: migration.version,
      name: migration.name,
      direction: 'down',
      durationMs: Math.round(performance.now() - started),
    };
  }

  /**
   * Runs `body` inside a transaction, unless the migration opted out.
   *
   * Opting out exists for statements Postgres refuses to run in one, such as
   * `create index concurrently`. Those migrations can leave a half-applied
   * schema behind if they fail, which is why the directive has to be written
   * deliberately into the file.
   */
  async #maybeTransactional(useTransaction: boolean, body: () => Promise<void>): Promise<void> {
    if (!useTransaction) {
      await body();
      return;
    }

    await this.client.query('begin');
    try {
      await body();
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback').catch(() => undefined);
      throw error;
    }
  }

  async #locked<T>(body: () => Promise<T>): Promise<T> {
    await this.client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      return await body();
    } finally {
      await this.client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  }
}
