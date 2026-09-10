/**
 * `@integr8/db` — the only way anything in this workspace reaches Postgres.
 *
 * The export list below is the whole surface, and what it deliberately omits is
 * as important as what it includes: no Kysely instance, no `pg` pool, no `sql`
 * template. Callers get `getTenantDataSource(tenantId)` and repositories. That,
 * plus the lint rule banning `kysely` and `pg` imports outside this package,
 * means a query with no `tenant_id` filter is not something a hurried afternoon
 * can produce.
 *
 * Three controls stack behind that, each sufficient on its own and each tested
 * on its own by the isolation suite:
 *
 *   1. The repository layer supplies `tenant_id` from the transaction's scope.
 *   2. `TenantGuardPlugin` refuses any statement touching a tenant-scoped table
 *      that names no `tenant_id`.
 *   3. RLS policies in Postgres check it again, against a transaction-local GUC
 *      set from the verified JWT claim.
 */

export {
  closeDatabase,
  configureDatabase,
  getPlatformDataSource,
  getTenantDataSource,
  RlsNotEnforcedError,
  withTenant,
  type PlatformDataSource,
  type TenantDataSource,
  type TenantTransaction,
} from './connection.js';

export {
  databaseConfigSchema,
  loadDatabaseConfig,
  requireAdminConnectionString,
  type DatabaseConfig,
} from './config.js';

export { MissingTenantScopeError } from './tenant-guard.js';

export {
  AUDIT_ACTOR_KINDS,
  auditActorKindSchema,
  MEMBERSHIP_STATUSES,
  membershipStatusSchema,
  PLATFORM_TABLES,
  TENANT_ROLES,
  TENANT_SCOPED_TABLES,
  TENANT_STATUSES,
  tenantStatusSchema,
  type AuditActorKind,
  type MembershipStatus,
  type PlatformTable,
  type TenantRole,
  type TenantScopedTable,
  type TenantStatus,
} from './schema.js';

export type {
  AppendAuditEntryInput,
  AuditEntry,
  ListAuditEntriesOptions,
} from './repositories/audit-log.js';
export type { AuditLogRepository } from './repositories/audit-log.js';

export type {
  CreateTenantUserInput,
  ListTenantUsersOptions,
  TenantUser,
} from './repositories/tenant-users.js';
export type { TenantUsersRepository } from './repositories/tenant-users.js';

export type { CreateTenantInput, Tenant } from './repositories/tenants.js';
export type { TenantsRepository } from './repositories/tenants.js';

export type { CreatePlatformUserInput, PlatformUser } from './repositories/platform-users.js';
export type { PlatformUsersRepository } from './repositories/platform-users.js';

export { WarmLruCache, type EvictionReason, type WarmLruOptions } from './warm-lru.js';
