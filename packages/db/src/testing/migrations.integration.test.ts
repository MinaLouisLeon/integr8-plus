import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '../migrator/files.js';
import { MigrationChecksumError, Migrator } from '../migrator/runner.js';
import { assertSchemaUpToDate, SchemaOutOfDateError } from '../migrator/status.js';
import { connectAsOwner, releaseTestDatabase } from './harness.js';

/**
 * The migration toolchain, exercised against a real database.
 *
 * The global setup has already rolled the whole schema down and back up before
 * any of this runs, so the `down` files are proven by the time these tests
 * start. What is left to prove is the discipline around them: that the version
 * table records what ran, that editing an applied migration is caught, and that
 * a single migration can be rolled back and reapplied — the operation a bad
 * deploy actually needs at the moment it needs it.
 */

let owner: pg.Client;
let migrator: Migrator;

beforeAll(async () => {
  owner = await connectAsOwner();
  migrator = new Migrator(owner, loadMigrations());
});

afterAll(async () => {
  // Leave the schema fully applied whatever happened above.
  await migrator.up();
  await owner.end();
  // assertSchemaUpToDate reads over the platform pool.
  await releaseTestDatabase();
});

describe('the version table', () => {
  it('records every migration on disk as applied', async () => {
    const statuses = await migrator.status();

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((entry) => entry.state === 'applied')).toBe(true);
  });

  it('records who applied each migration and how long it took', async () => {
    const rows = await migrator.applied();

    for (const row of rows) {
      expect(row.applied_by).not.toBe('');
      expect(row.execution_ms).toBeGreaterThanOrEqual(0);
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('is not readable by the runtime role', async () => {
    const result = await owner.query(
      `select count(*)::int as count from information_schema.role_table_grants
       where grantee = 'integr8_app' and table_name = 'schema_migrations'`,
    );

    expect((result.rows[0] as { count: number }).count).toBe(0);
  });
});

describe('an applied migration is immutable', () => {
  it('refuses to run when a file has changed since it was applied', async () => {
    const [first] = await migrator.applied();
    expect(first).toBeDefined();

    const original = first?.checksum ?? '';
    await owner.query('update schema_migrations set checksum = $1 where version = $2', [
      '0'.repeat(64),
      first?.version,
    ]);

    try {
      await expect(migrator.verify()).rejects.toThrow(MigrationChecksumError);
      await expect(migrator.up()).rejects.toThrow(/has changed since/u);
    } finally {
      await owner.query('update schema_migrations set checksum = $1 where version = $2', [
        original,
        first?.version,
      ]);
    }

    await expect(migrator.verify()).resolves.toBeUndefined();
  });

  it('refuses to run when an applied migration older than the newest file has no file', async () => {
    // A gap, not a newer release: the file was deleted or renamed.
    await owner.query(
      `insert into schema_migrations (version, name, checksum, execution_ms)
       values ('0000', 'deleted_since', $1, 1)`,
      ['0'.repeat(64)],
    );

    try {
      await expect(migrator.verify()).rejects.toThrow(/0000_deleted_since .*its file is gone/u);
      await expect(migrator.up()).rejects.toThrow(/its file is gone/u);
      await expect(assertSchemaUpToDate()).rejects.toThrow(SchemaOutOfDateError);
    } finally {
      await owner.query(`delete from schema_migrations where version = '0000'`);
    }
  });

  it('refuses a build whose files have a gap where the database has a migration', async () => {
    const all = loadMigrations();
    const middle = all[Math.floor(all.length / 2)];
    const withGap = new Migrator(
      owner,
      all.filter((migration) => migration !== middle),
    );

    await expect(withGap.verify()).rejects.toThrow(/its file is gone/u);
    await expect(withGap.up()).rejects.toThrow(MigrationChecksumError);
    await expect(withGap.down()).rejects.toThrow(MigrationChecksumError);
  });
});

describe('an earlier build on a newer schema (rolling back a release)', () => {
  // The previous release's image: the same files, less the newest two, which a
  // newer release has applied.
  const earlier = () => new Migrator(owner, loadMigrations().slice(0, -2));

  it('reports the newer migrations as ahead of the build, and passes verify', async () => {
    const statuses = await earlier().status();
    const newest = statuses.slice(-2);

    expect(newest.map((entry) => entry.state)).toEqual(['ahead-of-build', 'ahead-of-build']);
    expect(statuses.slice(0, -2).every((entry) => entry.state === 'applied')).toBe(true);
    await expect(earlier().verify()).resolves.toBeUndefined();
    expect((await earlier().aheadOfBuild()).map((entry) => entry.version)).toEqual(
      newest.map((entry) => entry.version),
    );
  });

  it('applies nothing on up, so migrate exits cleanly and the API and worker start', async () => {
    const before = await migrator.applied();

    await expect(earlier().up()).resolves.toEqual([]);
    expect(await migrator.applied()).toEqual(before);
  });

  it('refuses to roll back a migration it has no file for, and rolls back nothing', async () => {
    const before = await migrator.applied();

    await expect(earlier().down()).rejects.toThrow(
      /a newer release applied it, and this build has no down file for it/u,
    );
    await expect(earlier().down({ to: '0001' })).rejects.toThrow(/a newer release applied it/u);
    expect(await migrator.applied()).toEqual(before);
  });

  it('is ready for traffic, naming what is ahead', async () => {
    // assertSchemaUpToDate reads the real files, so here the newer release is
    // a row this build has no file for.
    await owner.query(
      `insert into schema_migrations (version, name, checksum, execution_ms)
       values ('9999', 'from_the_future', $1, 1)`,
      ['0'.repeat(64)],
    );

    try {
      await expect(assertSchemaUpToDate()).resolves.toEqual({
        aheadOfBuild: ['9999_from_the_future'],
      });
      await expect(migrator.verify()).resolves.toBeUndefined();
      await expect(migrator.up()).resolves.toEqual([]);
    } finally {
      await owner.query(`delete from schema_migrations where version = '9999'`);
    }
  });

  it('refuses when this build also has a migration the newer release never applied', async () => {
    // The newest migration's row is taken out rather than the migration rolled
    // back: rolling back 0058 or later would also take away the platform
    // role's read of this table, which the readiness check uses.
    const [latest] = (await migrator.applied()).slice(-1);
    if (latest === undefined) {
      throw new Error('no migration applied');
    }
    await owner.query('delete from schema_migrations where version = $1', [latest.version]);
    await owner.query(
      `insert into schema_migrations (version, name, checksum, execution_ms)
       values ('9999', 'from_the_future', $1, 1)`,
      ['0'.repeat(64)],
    );

    try {
      await expect(migrator.verify()).rejects.toThrow(
        new RegExp(`${latest.version}_\\w+ has not been applied, yet the database`, 'u'),
      );
      await expect(migrator.up()).rejects.toThrow(MigrationChecksumError);
      await expect(assertSchemaUpToDate()).rejects.toThrow(/\(pending\)/u);
    } finally {
      await owner.query(`delete from schema_migrations where version = '9999'`);
      await owner.query(
        `insert into schema_migrations (version, name, checksum, applied_at, applied_by, execution_ms)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          latest.version,
          latest.name,
          latest.checksum,
          latest.applied_at,
          latest.applied_by,
          latest.execution_ms,
        ],
      );
    }
  });
});

describe('rolling back and reapplying', () => {
  it('takes the most recent migration down and puts it back', async () => {
    const before = await migrator.applied();
    const latest = before.at(-1);
    expect(latest).toBeDefined();

    const rolledBack = await migrator.down({ steps: 1 });
    expect(rolledBack).toHaveLength(1);
    expect(rolledBack[0]?.version).toBe(latest?.version);

    const during = await migrator.status();
    expect(during.find((entry) => entry.version === latest?.version)?.state).toBe('pending');

    const reapplied = await migrator.up();
    expect(reapplied.map((outcome) => outcome.version)).toEqual([latest?.version]);

    const after = await migrator.status();
    expect(after.every((entry) => entry.state === 'applied')).toBe(true);
  });

  it('rolls back exactly one migration when given no arguments', async () => {
    const rolledBack = await migrator.down();
    expect(rolledBack).toHaveLength(1);
    await migrator.up();
  });

  it('restores a schema that works, not merely one that exists', async () => {
    await migrator.down({ to: '0000' });

    const tablesGone = await owner.query(
      `select count(*)::int as count from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'tenant_users'`,
    );
    expect((tablesGone.rows[0] as { count: number }).count).toBe(0);

    await migrator.up();

    // A round trip through the rebuilt schema, including the RLS policy that
    // 0002 recreates.
    const tenant = await owner.query<{ id: string }>(
      `insert into tenants (slug, name) values ('rebuilt-check', 'Rebuilt Check Ltd') returning id`,
    );
    await owner.query(
      `insert into tenant_users (tenant_id, user_id, email, display_name, role)
       values ($1, gen_random_uuid(), 'rebuilt@check.example', 'Rebuilt Check', 'owner')`,
      [tenant.rows[0]?.id],
    );

    const policies = await owner.query(
      `select count(*)::int as count from pg_policies where schemaname = 'public'`,
    );
    expect((policies.rows[0] as { count: number }).count).toBeGreaterThan(0);
  });
});

describe('concurrency', () => {
  it('serialises two migrators rather than letting them interleave', async () => {
    const second = await connectAsOwner();
    try {
      const other = new Migrator(second, loadMigrations());

      // Both have nothing to do, but both take the advisory lock. If the lock
      // were missing this would still pass; what it proves is that taking and
      // releasing it does not deadlock, which a mistaken `pg_advisory_lock`
      // pairing would.
      const [a, b] = await Promise.all([migrator.up(), other.up()]);
      expect(a).toEqual([]);
      expect(b).toEqual([]);
    } finally {
      await second.end();
    }
  });
});
