import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../config.js';
import {
  assertPlatformRoleIsLimited,
  closeDatabase,
  configureDatabase,
  PlatformRoleTooBroadError,
} from '../connection.js';
import {
  connectAsPlatform,
  createTenant,
  releaseTestDatabase,
  useTestDatabase,
} from './harness.js';

/**
 * What `integr8_platform` can and cannot do, tried for real (0058).
 *
 * The schema-invariant suite reads its grants from the catalogue. This one
 * connects as it, because the reason it exists is what a compromised API or
 * worker could do with its password, and that is best shown by trying.
 */

let platform: pg.Client;

beforeAll(async () => {
  useTestDatabase();
  platform = await connectAsPlatform();
});

afterAll(async () => {
  await platform.end();
  await releaseTestDatabase();
});

describe('the platform role', () => {
  it('reads and writes rows of any company, past RLS', async () => {
    const tenant = await createTenant('platform-role');

    const read = await platform.query<{ name: string }>('select name from tenants where id = $1', [
      tenant.id,
    ]);
    expect(read.rows).toEqual([{ name: tenant.name }]);

    await platform.query('update tenants set name = $2 where id = $1', [tenant.id, 'Renamed Ltd']);
    const users = await platform.query(
      `insert into tenant_users (tenant_id, user_id, email, display_name, role)
       values ($1, gen_random_uuid(), 'someone@example.com', 'Someone', 'engineer') returning id`,
      [tenant.id],
    );
    expect(users.rowCount).toBe(1);
  });

  it('reads the migration history and cannot write it', async () => {
    const applied = await platform.query('select version from schema_migrations limit 1');
    expect(applied.rowCount).toBe(1);
    await expect(
      platform.query(
        `insert into schema_migrations (version, name, checksum, execution_ms)
         values ('9998', 'forged', 'x', 1)`,
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('cannot change the schema', async () => {
    await expect(platform.query('create table platform_was_here (id int)')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(platform.query('alter table tenants add column extra text')).rejects.toThrow(
      /must be owner/u,
    );
    await expect(platform.query('drop table platform_users')).rejects.toThrow(/must be owner/u);
  });

  it('cannot lift a guard trigger, truncate, or step outside the database', async () => {
    await expect(
      platform.query('alter table audit_log disable trigger audit_log_no_delete'),
    ).rejects.toThrow(/must be owner/u);
    await expect(platform.query('truncate table audit_log')).rejects.toThrow(/permission denied/u);
    await expect(platform.query('set session_replication_role = replica')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(platform.query(`select pg_read_file('postgresql.conf')`)).rejects.toThrow(
      /permission denied/u,
    );
    await expect(platform.query('create role someone_else login')).rejects.toThrow(
      /permission denied/u,
    );
  });
});

describe('the start-up check the API and worker run in production', () => {
  it('accepts the platform role', async () => {
    await expect(assertPlatformRoleIsLimited()).resolves.toBeUndefined();
  });

  it('refuses the owner, which an env file without DATABASE_URL_PLATFORM falls back to', async () => {
    await closeDatabase();
    configureDatabase({ ...loadDatabaseConfig(), DATABASE_URL_PLATFORM: undefined });
    try {
      const message = await assertPlatformRoleIsLimited().then(
        () => '',
        (error: unknown) => {
          expect(error).toBeInstanceOf(PlatformRoleTooBroadError);
          return error instanceof Error ? error.message : '';
        },
      );
      expect(message).toMatch(/is a superuser/u);
    } finally {
      await closeDatabase();
      useTestDatabase();
    }
  });
});
