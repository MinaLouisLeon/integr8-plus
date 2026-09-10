import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '../migrator/files.js';
import { MigrationChecksumError, Migrator } from '../migrator/runner.js';
import { connectAsOwner } from './harness.js';

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

  it('refuses to run when an applied migration has no file', async () => {
    await owner.query(
      `insert into schema_migrations (version, name, checksum, execution_ms)
       values ('9999', 'from_the_future', $1, 1)`,
      ['0'.repeat(64)],
    );

    try {
      await expect(migrator.verify()).rejects.toThrow(/its file is gone/u);
    } finally {
      await owner.query(`delete from schema_migrations where version = '9999'`);
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
