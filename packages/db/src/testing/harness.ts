import { type TenantId, toTenantId } from '@integr8/core';
import pg from 'pg';
import {
  buildTenantTransaction,
  closeDatabase,
  configureDatabase,
  getPlatformDb,
  type TenantTransaction,
} from '../connection.js';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';

const { Client } = pg;

/**
 * Shared machinery for the integration suites.
 *
 * The suites here truncate tables, so the first thing this module does is make
 * that hard to do by accident. Two independent env vars have to agree that this
 * database is disposable, and neither has a default.
 */

const DISPOSABLE_ACKNOWLEDGEMENT = 'i-know-this-database-is-disposable';

export class TestDatabaseUnavailableError extends Error {
  constructor(reason: string) {
    super(
      [
        `Cannot run the database integration suite: ${reason}`,
        '',
        'These tests need a disposable Postgres — a Supabase branch, not production.',
        'Set, in packages/db/.env:',
        '',
        '  APP_ENV=test',
        `  INTEGR8_TEST_DATABASE=${DISPOSABLE_ACKNOWLEDGEMENT}`,
        '  DATABASE_URL=postgres://integr8_app....      (runtime role)',
        '  DATABASE_URL_ADMIN=postgres://postgres....   (owner role)',
        '',
        'docs/database/runbook-supabase-setup.md walks through creating them.',
      ].join('\n'),
    );
    this.name = 'TestDatabaseUnavailableError';
  }
}

/**
 * Asserts this process is pointed at a database it is allowed to destroy.
 *
 * `APP_ENV=test` alone is not enough: it is the kind of variable that gets left
 * set in a shell that later runs something else. The second acknowledgement has
 * no other purpose and no other value, so it cannot be set by accident.
 */
export function requireDisposableDatabase(env: NodeJS.ProcessEnv = process.env): {
  appUrl: string;
  adminUrl: string;
} {
  if (env.APP_ENV !== 'test') {
    throw new TestDatabaseUnavailableError(`APP_ENV is "${env.APP_ENV ?? '(unset)'}", not "test"`);
  }
  if (env.INTEGR8_TEST_DATABASE !== DISPOSABLE_ACKNOWLEDGEMENT) {
    throw new TestDatabaseUnavailableError(
      'INTEGR8_TEST_DATABASE is not set to the acknowledgement',
    );
  }

  const config = loadDatabaseConfig(env);
  return { appUrl: config.DATABASE_URL, adminUrl: requireAdminConnectionString(config) };
}

/** A `pg.Client` as the schema owner, for migrations and catalogue queries. */
export async function connectAsOwner(): Promise<pg.Client> {
  const { adminUrl } = requireDisposableDatabase();
  const client = new Client({ connectionString: adminUrl, application_name: 'integr8-tests' });
  await client.connect();
  return client;
}

/** A `pg.Client` as `integr8_app`, for the RLS suite's deliberately raw SQL. */
export async function connectAsApp(): Promise<pg.Client> {
  const { appUrl } = requireDisposableDatabase();
  const client = new Client({ connectionString: appUrl, application_name: 'integr8-tests-app' });
  await client.connect();
  return client;
}

/** Points `@integr8/db` at the test database. Call once per test file. */
export function useTestDatabase(): void {
  requireDisposableDatabase();
  configureDatabase(loadDatabaseConfig());
}

export async function releaseTestDatabase(): Promise<void> {
  await closeDatabase();
}

/**
 * The truncate guards that stand between a test run and an empty schema.
 *
 * Each rejects `truncate` for every role, the owner included, which is the whole
 * point of the guarantee — so each comes off for the duration of one statement
 * and goes straight back on, inside `finally`.
 */
const TRUNCATE_GUARDS = [
  { table: 'audit_log', trigger: 'audit_log_no_truncate' },
  { table: 'form_versions', trigger: 'form_versions_no_truncate' },
  { table: 'submission_events', trigger: 'submission_events_no_truncate' },
  { table: 'work_order_events', trigger: 'work_order_events_no_truncate' },
] as const;

/**
 * Empties every tenant table.
 *
 * This function and the development seed reset are the only places in the
 * repository that lift an immutability guard, and both refuse to run outside a
 * database explicitly marked disposable.
 */
export async function truncateAll(): Promise<void> {
  requireDisposableDatabase();
  const client = await connectAsOwner();
  try {
    for (const guard of TRUNCATE_GUARDS) {
      await client.query(`alter table ${guard.table} disable trigger ${guard.trigger}`);
    }
    try {
      await client.query(
        'truncate table audit_log, tenant_users, tenants restart identity cascade',
      );
    } finally {
      for (const guard of TRUNCATE_GUARDS) {
        await client.query(`alter table ${guard.table} enable trigger ${guard.trigger}`);
      }
    }
    await client.query('truncate table platform_users cascade');
  } finally {
    await client.end();
  }
}

export interface TenantFixture {
  id: TenantId;
  slug: string;
  name: string;
}

let fixtureCounter = 0;

/** Creates a company directly, as the owner, bypassing the application path. */
export async function createTenant(slugPrefix: string): Promise<TenantFixture> {
  fixtureCounter += 1;
  const slug = `${slugPrefix}-${String(Date.now() % 100_000)}-${String(fixtureCounter)}`;

  const row = await getPlatformDb()
    .insertInto('tenants')
    .values({ slug, name: `${slugPrefix} Facilities Ltd` })
    .returning(['id', 'slug', 'name'])
    .executeTakeFirstOrThrow();

  return { id: toTenantId(row.id), slug: row.slug, name: row.name };
}

/**
 * Runs the repositories against the **owner** connection, where RLS does not
 * apply.
 *
 * This is what makes the repository-isolation suite mean something. Run through
 * the normal tenant data source, a repository that forgot its `tenant_id`
 * filter would still return only its own rows, because RLS would quietly catch
 * it — and the suite would pass while the primary control was broken. Here
 * there is no backstop and no query guard: if the filter is not in the SQL, the
 * other company's rows come back and the test fails.
 *
 * The RLS backstop gets its own suite, exercised on its own, for the same
 * reason in reverse.
 */
export async function withUnprotectedRepositories<T>(
  tenantId: TenantId,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return getPlatformDb()
    .transaction()
    .execute(async (trx) => fn(buildTenantTransaction({ tenantId, trx })));
}

/** Sets the tenant GUC on a raw client the way the runtime does, then runs `body`. */
export async function asTenant<T>(
  client: pg.Client,
  tenantId: string | null,
  body: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId ?? '']);
    const result = await body();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
