import { type TenantId, toTenantId } from '@integr8/core';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import {
  type DatabaseConfig,
  loadDatabaseConfig,
  requireAdminConnectionString,
  requireAuthConnectionString,
} from './config.js';
import { AuditLogRepository } from './repositories/audit-log.js';
import { AuthMembershipsRepository } from './repositories/auth-memberships.js';
import { IdempotencyRepository } from './repositories/idempotency.js';
import { ImpersonationRepository } from './repositories/impersonation.js';
import {
  type ClaimedJob,
  claimJobs,
  completeJob,
  type FailJobOptions,
  failJob,
  JobsRepository,
} from './repositories/jobs.js';
import { FormsRepository } from './repositories/forms.js';
import { SubmissionsRepository } from './repositories/submissions.js';
import { InvitationsRepository } from './repositories/invitations.js';
import { LoginSecurityRepository } from './repositories/login-security.js';
import { OfflineGrantsRepository } from './repositories/offline-grants.js';
import { RateLimitRepository } from './repositories/rate-limits.js';
import { SessionsRepository } from './repositories/sessions.js';
import { PlatformUsersRepository } from './repositories/platform-users.js';
import { TenantsRepository } from './repositories/tenants.js';
import type { TenantScope } from './repositories/tenant-scope.js';
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
  readonly sessions: SessionsRepository;
  readonly invitations: InvitationsRepository;
  readonly impersonation: ImpersonationRepository;
  readonly offlineGrants: OfflineGrantsRepository;
  readonly idempotency: IdempotencyRepository;
  readonly jobs: JobsRepository;
  readonly forms: FormsRepository;
  readonly submissions: SubmissionsRepository;
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

/**
 * Claiming and finishing background jobs, across every company.
 *
 * The one queue operation that cannot be tenant-scoped: a worker polls for
 * whatever work exists, and "whatever exists" spans companies. Each job it
 * claims is then executed inside a tenant transaction for that job's own
 * `tenant_id`, so the privilege stops at the claim.
 */
export interface PlatformJobQueue {
  claim: (options: {
    workerId: string;
    limit?: number;
    leaseMs?: number;
    now?: Date;
  }) => Promise<ClaimedJob[]>;
  complete: (jobId: string, at?: Date) => Promise<void>;
  fail: (jobId: string, options: FailJobOptions) => Promise<'retrying' | 'dead'>;
}

/** A connection as the schema owner. RLS does not apply — see {@link getPlatformDataSource}. */
export interface PlatformDataSource {
  readonly tenants: TenantsRepository;
  readonly platformUsers: PlatformUsersRepository;
  readonly jobs: PlatformJobQueue;
}

/**
 * The pre-authentication connection.
 *
 * Sign-in has to do two things before any company is known: decide whether this
 * address is locked out, and find which companies the identity belongs to.
 * Neither question has a tenant to scope by, so neither can be asked over the
 * tenant connection — and giving the tenant runtime role a cross-tenant read
 * would undo the thing P02 spent its whole phase establishing.
 *
 * `integr8_auth` reaches `login_attempts`, `account_locks` and the
 * `auth_memberships` view. Nothing else, checked at startup by
 * {@link assertAuthRoleIsNarrow} and again in the schema-invariant suite.
 */
export interface AuthDataSource {
  readonly loginSecurity: LoginSecurityRepository;
  readonly memberships: AuthMembershipsRepository;
  readonly rateLimits: RateLimitRepository;
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
  authPool?: pg.Pool | undefined;
  authDb?: Promise<Kysely<Database>> | undefined;
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

        return fn(buildTenantTransaction({ tenantId, trx }));
      }),
  };
}

/**
 * Assembles the repositories for one tenant transaction.
 *
 * Exported inside the package because the isolation harness builds a
 * transaction over the owner connection, where RLS does not apply, to prove the
 * repository layer stands up on its own. Both paths going through one factory
 * means a repository added here cannot be left out of the suite that tests it.
 */
export function buildTenantTransaction(scope: TenantScope): InternalTenantTransaction {
  return {
    tenantId: scope.tenantId,
    trx: scope.trx,
    tenantUsers: new TenantUsersRepository(scope),
    auditLog: new AuditLogRepository(scope),
    sessions: new SessionsRepository(scope),
    invitations: new InvitationsRepository(scope),
    impersonation: new ImpersonationRepository(scope),
    offlineGrants: new OfflineGrantsRepository(scope),
    idempotency: new IdempotencyRepository(scope),
    jobs: new JobsRepository(scope),
    forms: new FormsRepository(scope),
    submissions: new SubmissionsRepository(scope),
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
    jobs: {
      claim: (options) => claimJobs(db, options),
      complete: (jobId, at) => completeJob(db, jobId, at),
      fail: (jobId, options) => failJob(db, jobId, options),
    },
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

/**
 * The connection sign-in uses before it knows which company it is dealing with.
 */
export async function getAuthDataSource(): Promise<AuthDataSource> {
  const db = await getAuthDb();
  return {
    loginSecurity: new LoginSecurityRepository(db),
    memberships: new AuthMembershipsRepository(db),
    rateLimits: new RateLimitRepository(db),
  };
}

async function getAuthDb(): Promise<Kysely<Database>> {
  const current = getState();
  current.authDb ??= (async () => {
    const pool = new Pool({
      connectionString: requireAuthConnectionString(current.config),
      // Sign-in is a small fraction of traffic and every connection here can
      // read across companies, so the pool is deliberately tight.
      max: current.config.DB_AUTH_POOL_MAX,
      idleTimeoutMillis: current.config.DB_POOL_IDLE_MS,
      connectionTimeoutMillis: current.config.DB_POOL_ACQUIRE_TIMEOUT_MS,
      keepAlive: true,
      application_name: 'integr8-auth',
    });
    current.authPool = pool;

    const db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new TenantGuardPlugin()],
    });
    await assertAuthRoleIsNarrow(db);
    return db;
  })();

  try {
    return await current.authDb;
  } catch (error) {
    current.authDb = undefined;
    await current.authPool?.end().catch(() => undefined);
    current.authPool = undefined;
    throw error;
  }
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
  await current.authDb?.then((db) => db.destroy()).catch(() => undefined);
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

export class AuthRoleTooBroadError extends Error {
  constructor(reasons: string[]) {
    super(
      [
        'Refusing to open the pre-authentication pool: this role can reach more than sign-in needs.',
        ...reasons.map((reason) => `  - ${reason}`),
        '',
        'DATABASE_URL_AUTH must connect as integr8_auth, which holds privileges on',
        'login_attempts, account_locks and the auth_memberships view and nothing else.',
        'See docs/database/runbook-supabase-setup.md.',
      ].join('\n'),
    );
    this.name = 'AuthRoleTooBroadError';
  }
}

/**
 * Proves the pre-authentication connection is as narrow as it is supposed to be.
 *
 * This role exists to read across companies — that is its whole purpose, and it
 * is the one role in the system RLS cannot constrain. What keeps that safe is
 * that it can reach three objects. A connection string pointed at the wrong
 * role would turn the narrowest thing in the schema into the widest, silently,
 * so it is checked once at startup rather than assumed.
 */
export async function assertAuthRoleIsNarrow(db: Kysely<Database>): Promise<void> {
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
    throw new AuthRoleTooBroadError(['could not read the current role from pg_roles']);
  }
  if (role.is_superuser) {
    reasons.push(`role ${role.current_user} is a superuser`);
  }
  if (role.bypasses_rls) {
    reasons.push(`role ${role.current_user} has BYPASSRLS`);
  }

  // The decisive check: every tenant-scoped table must be out of reach. If this
  // role could read one, it would read it across every company at once.
  const reachable = await sql<{ table_name: string }>`
    select distinct g.table_name::text as table_name
    from information_schema.role_table_grants g
    where g.grantee = current_user
      and g.table_schema = 'public'
      and g.table_name = any(${sql.val(TENANT_SCOPED_TABLES)}::text[])
    order by 1
  `.execute(db);

  if (reachable.rows.length > 0) {
    reasons.push(
      `role ${role.current_user} holds privileges on tenant-scoped table(s): ${reachable.rows
        .map((row) => row.table_name)
        .join(', ')}`,
    );
  }

  if (reasons.length > 0) {
    throw new AuthRoleTooBroadError(reasons);
  }
}
