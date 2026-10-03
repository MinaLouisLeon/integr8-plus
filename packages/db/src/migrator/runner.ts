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
  state: 'applied' | 'pending' | 'missing-file' | 'checksum-mismatch';
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
    const applied = new Map((await this.applied()).map((row) => [row.version, row]));
    const onDisk = new Map(this.migrations.map((migration) => [migration.version, migration]));

    const versions = [...new Set([...applied.keys(), ...onDisk.keys()])].sort((a, b) =>
      a.localeCompare(b),
    );

    return versions.map((version) => {
      const file = onDisk.get(version);
      const row = applied.get(version);

      if (row === undefined) {
        return { version, name: file?.name ?? '(unknown)', state: 'pending' as const };
      }
      if (file === undefined) {
        return { version, name: row.name, state: 'missing-file', appliedAt: row.applied_at };
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
   * Throws if any applied migration differs from its file, or has no file.
   *
   * Called before every `up`, so an edited migration blocks a deploy rather
   * than producing two databases that quietly disagree.
   */
  async verify(): Promise<void> {
    const problems = (await this.status())
      .filter((entry) => entry.state === 'checksum-mismatch' || entry.state === 'missing-file')
      .map((entry) =>
        entry.state === 'missing-file'
          ? `${entry.version}_${entry.name} was applied but its file is gone`
          : `${entry.version}_${entry.name} was applied but its file has changed since`,
      );

    if (problems.length > 0) {
      throw new MigrationChecksumError(problems);
    }
  }

  /** Applies every pending migration, or stops after `to`. */
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

      const outcomes: MigrationOutcome[] = [];
      for (const row of targets) {
        const migration = byVersion.get(row.version);
        if (migration === undefined) {
          throw new Error(
            `Cannot roll back ${row.version}_${row.name}: its file is not on disk. Restore it from git first.`,
          );
        }
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
