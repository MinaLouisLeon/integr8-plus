import { type TenantId, toTenantId } from '@integr8/core';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { type DatabaseConfig, loadDatabaseConfig, requireAdminConnectionString } from './config.js';
import { AuditLogRepository } from './repositories/audit-log.js';
import { PlatformUsersRepository } from './repositories/platform-users.js';
import { TenantsRepository } from './repositories/tenants.js';
import { TenantUsersRepository } from './repositories/tenant-users.js';
import { TENANT_SCOPED_TABLES, type Database } from './schema.js';
import { TenantGuardPlugin } from './tenant-guard.js';
import { WarmLruCache } from './warm-lru.js';

const { Pool } = pg;

/**
 * Connection management and the tenant seam.
 *
 * `getTenantDataSource(tenantId)` is the single door onto tenant data. Today
 * every tenant gets a handle onto one shared pool against one shared Supabase
 * database. P35 sells an enterprise tier where a company gets its own database;
 * when that lands, this function returns a data source backed by that
 * company's pool and nothing above it changes. Building the seam now costs a
 * function; retrofitting it later costs every call site.
 */

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * A transaction acting for exactly one tenant.
 *
 * The `app.tenant_id` GUC is set for its lifetime, so RLS is armed, and the
 * repositories hanging off it inject `tenant_id` into every statement.
 */
export interface TenantTransaction {
  readonly tenantId: TenantId;
  readonly tenantUsers: TenantUsersRepository;
  readonly auditLog: AuditLogRepository;
}

/**
 * The same transaction, plus the Kysely handle underneath it.
 *
 * Not exported from the package. Callers outside `@integr8/db` get
 * {@link TenantTransaction}, which has repositories and no way to reach the
 * query builder — so "use a repository" is the only option rather than the
 * recommended one.
 */
export interface InternalTenantTransaction extends TenantTransaction {
  readonly trx: Transaction<Database>;
}

export interface TenantDataSource {
  readonly tenantId: TenantId;
  /**
   * Runs `fn` inside a transaction scoped to this tenant.
   *
   * Every tenant read and write goes through here. The scoping is
   * transaction-local (`set_config(..., true)`) because Supavisor runs in
   * transaction mode: a session-level setting would outlive the transaction and
   * be inherited by whichever tenant got the connection next.
   */
  transaction: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
}

/** A connection as the schema owner. RLS does not apply — see {@link getPlatformDataSource}. */
export interface PlatformDataSource {
  readonly tenants: TenantsRepository;
  readonly platformUsers: PlatformUsersRepository;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface DatabaseState {
  config: DatabaseConfig;
  appPool?: pg.Pool | undefined;
  appDb?: Promise<Kysely<Database>> | undefined;
  adminPool?: pg.Pool | undefined;
  adminDb?: Kysely<Database> | undefined;
  tenants: WarmLruCache<TenantId, TenantDataSource>;
}

let state: DatabaseState | undefined;

/**
 * Configures the database layer explicitly instead of reading `process.env`.
 *
 * Tests use it to point at a scratch database. Applications normally pass
 * nothing and let the first `getTenantDataSource` read the environment.
 */
export function configureDatabase(config: DatabaseConfig): void {
  if (state !== undefined) {
    throw new Error(
      'configureDatabase() called after the database was already in use. Call closeDatabase() first.',
    );
  }
  state = createState(config);
}

function createState(config: DatabaseConfig): DatabaseState {
  return {
    config,
    tenants: new WarmLruCache<TenantId, TenantDataSource>({
      max: config.DB_TENANT_CACHE_MAX,
      idleMs: config.DB_TENANT_CACHE_IDLE_MS,
      // Every entry currently shares the process-wide app pool, so there is
      // nothing per-tenant to close. P35 replaces this with a pool shutdown for
      // entries that own one.
      dispose: () => undefined,
    }),
  };
}

function getState(): DatabaseState {
  state ??= createState(loadDatabaseConfig());
  return state;
}

// ---------------------------------------------------------------------------
// The tenant seam
// ---------------------------------------------------------------------------

/**
 * Returns the data source for one tenant, warm if it has been used recently.
 *
 * The `tenantId` is re-parsed rather than trusted. It arrives from a JWT claim,
 * and a value that is not a UUID has no business reaching a `set_config` call.
 */
export async function getTenantDataSource(tenantId: TenantId | string): Promise<TenantDataSource> {
  const id = toTenantId(tenantId);
  const current = getState();
  return current.tenants.getOrCreate(id, async () => createSharedTenantDataSource(id));
}

/** Convenience wrapper: acquire the data source and run one transaction on it. */
export async function withTenant<T>(
  tenantId: TenantId | string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const dataSource = await getTenantDataSource(tenantId);
  return dataSource.transaction(fn);
}

async function createSharedTenantDataSource(tenantId: TenantId): Promise<TenantDataSource> {
  const current = getState();
  const db = await getAppDb();
  const statementTimeoutMs = String(current.config.DB_STATEMENT_TIMEOUT_MS);

  return {
    tenantId,
    transaction: async <T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
      db.transaction().execute(async (trx) => {
        // One round trip, before anything else runs on this connection:
        // arm RLS for this tenant and cap how long the transaction may hold a
        // pooled connection. Both are transaction-local.
        await sql`select
            set_config('app.tenant_id', ${tenantId}, true),
            set_config('statement_timeout', ${statementTimeoutMs}, true)`.execute(trx);

        const scope = { tenantId, trx };
        return fn({
          ...scope,
          tenantUsers: new TenantUsersRepository(scope),
          auditLog: new AuditLogRepository(scope),
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

async function getAppDb(): Promise<Kysely<Database>> {
  const current = getState();
  current.appDb ??= (async () => {
    const pool = new Pool({
      connectionString: current.config.DATABASE_URL,
      max: current.config.DB_POOL_MAX,
      idleTimeoutMillis: current.config.DB_POOL_IDLE_MS,
      connectionTimeoutMillis: current.config.DB_POOL_ACQUIRE_TIMEOUT_MS,
      // Supavisor terminates idle connections itself; keepalive stops a NAT in
      // between silently dropping one we still think is good.
      keepAlive: true,
      application_name: 'integr8-api',
    });
    current.appPool = pool;

    const db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      // Every statement the runtime issues passes the guard. Attaching it to
      // the instance rather than to each transaction means a future code path
      // that gets a connection some other way is still covered.
      plugins: [new TenantGuardPlugin()],
    });
    await assertRlsEnforced(db);
    return db;
  })();

  try {
    return await current.appDb;
  } catch (error) {
    // A failed assertion must not wedge the process into never retrying.
    current.appDb = undefined;
    await current.appPool?.end().catch(() => undefined);
    current.appPool = undefined;
    throw error;
  }
}

/**
 * A connection as the schema owner, for the handful of operations that are
 * legitimately outside every tenant: creating a company, reading
 * `platform_users`, migrations, seeds.
 *
 * RLS does not apply to the owner. Nothing that serves a tenant request may use
 * this, and P03 puts platform authentication and a mandatory audit entry in
 * front of every caller that does.
 */
export function getPlatformDataSource(): PlatformDataSource {
  const db = getPlatformDb();
  return {
    tenants: new TenantsRepository(db),
    platformUsers: new PlatformUsersRepository(db),
  };
}

/**
 * The owner's Kysely handle. Internal: seeding and the test harness need to
 * write rows no repository offers, and neither is application code.
 */
export function getPlatformDb(): Kysely<Database> {
  const current = getState();
  current.adminDb ??= (() => {
    const pool = new Pool({
      connectionString: requireAdminConnectionString(current.config),
      // Deliberately small. Owner connections bypass RLS, so the fewer of them
      // exist at once the better.
      max: 2,
      idleTimeoutMillis: current.config.DB_POOL_IDLE_MS,
      connectionTimeoutMillis: current.config.DB_POOL_ACQUIRE_TIMEOUT_MS,
      application_name: 'integr8-platform',
    });
    current.adminPool = pool;
    return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  })();

  return current.adminDb;
}

/** Closes every pool and clears module state. Call on shutdown and between test files. */
export async function closeDatabase(): Promise<void> {
  const current = state;
  state = undefined;
  if (current === undefined) {
    return;
  }
  await current.tenants.drain();
  await current.appDb?.then((db) => db.destroy()).catch(() => undefined);
  await current.adminDb?.destroy().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The startup assertion
// ---------------------------------------------------------------------------

export class RlsNotEnforcedError extends Error {
  constructor(reasons: string[]) {
    super(
      [
        'Refusing to serve tenant traffic: row-level security is not enforced for this connection.',
        ...reasons.map((reason) => `  - ${reason}`),
        '',
        'DATABASE_URL must connect as integr8_app, which is neither the schema owner nor a',
        'superuser. See docs/database/runbook-supabase-setup.md.',
      ].join('\n'),
    );
    this.name = 'RlsNotEnforcedError';
  }
}

/**
 * Proves, at pool creation, that this connection is actually subject to RLS.
 *
 * Tables are `enable row level security` but not `force`, so the owner bypasses
 * every policy — which is what makes the repository-isolation suite meaningful,
 * and what makes connecting as the owner catastrophic. A connection string
 * edited in a hurry is exactly how that happens, so it is checked rather than
 * assumed, once, at startup.
 *
 * The checks are deliberately overlapping: three catalogue facts and one
 * empirical probe. The probe is the one that cannot be fooled by a privilege we
 * did not think to look for.
 */
export async function assertRlsEnforced(db: Kysely<Database>): Promise<void> {
  const reasons: string[] = [];

  const identity = await sql<{
    current_user: string;
    is_superuser: boolean;
    bypasses_rls: boolean;
  }>`
    select
      current_user::text as current_user,
      coalesce(r.rolsuper, false) as is_superuser,
      coalesce(r.rolbypassrls, false) as bypasses_rls
    from pg_roles r
    where r.rolname = current_user
  `.execute(db);

  const role = identity.rows[0];
  if (role === undefined) {
    throw new RlsNotEnforcedError(['could not read the current role from pg_roles']);
  }
  if (role.is_superuser) {
    reasons.push(`role ${role.current_user} is a superuser`);
  }
  if (role.bypasses_rls) {
    reasons.push(`role ${role.current_user} has BYPASSRLS`);
  }

  const owned = await sql<{ table_name: string }>`
    select c.relname::text as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and pg_get_userbyid(c.relowner) = current_user
    order by c.relname
  `.execute(db);

  if (owned.rows.length > 0) {
    reasons.push(
      `role ${role.current_user} owns ${String(owned.rows.length)} table(s) and so bypasses their policies: ${owned.rows
        .map((row) => row.table_name)
        .join(', ')}`,
    );
  }

  const unprotected = await sql<{ table_name: string }>`
    select c.relname::text as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = any(${sql.val(TENANT_SCOPED_TABLES)}::text[])
      and c.relrowsecurity = false
    order by c.relname
  `.execute(db);

  if (unprotected.rows.length > 0) {
    reasons.push(
      `row-level security is disabled on: ${unprotected.rows.map((row) => row.table_name).join(', ')}`,
    );
  }

  // Empirical: `platform_users` carries no grant for `integr8_app`, so reading
  // it must fail. Succeeding means this connection has privileges the schema
  // never gave it.
  try {
    await sql`select 1 from platform_users limit 1`.execute(db);
    reasons.push(
      `role ${role.current_user} can read platform_users, which is granted to no runtime role`,
    );
  } catch {
    // Expected: insufficient_privilege.
  }

  if (reasons.length > 0) {
    throw new RlsNotEnforcedError(reasons);
  }
}
