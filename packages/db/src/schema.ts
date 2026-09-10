import { type Role, ROLES } from '@integr8/core';
import type { ColumnType, Generated } from 'kysely';
import { z } from 'zod';

/**
 * The database's view of the schema, hand-written to match `migrations/`.
 *
 * It is hand-written rather than introspected because introspection can only
 * run against a live database, and a type that needs a database to exist is a
 * type nobody can check in CI before the migration has been applied. The
 * schema-invariant suite compares this file against the real catalogue, so
 * drift fails the build rather than surfacing in production.
 */

/** A timestamptz. Postgres supplies it; callers never write one by hand. */
type CreatedAt = ColumnType<Date, never, never>;

/** `updated_at`, maintained by the `set_updated_at` trigger. */
type UpdatedAt = ColumnType<Date, never, never>;

type Jsonb<T> = ColumnType<T, T | undefined, T>;

export const TENANT_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export const tenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended'] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const AUDIT_ACTOR_KINDS = ['tenant_user', 'platform_user', 'system'] as const;
export const auditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

/**
 * The role vocabulary the `tenant_users_role_known` check constraint accepts.
 * Re-exported from core so there is exactly one list; the schema-invariant
 * suite asserts the constraint in Postgres still matches it.
 */
export const TENANT_ROLES = ROLES;
export type TenantRole = Role;

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<TenantStatus>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: Date | null;
}

export interface PlatformUsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface TenantUsersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: TenantRole;
  status: Generated<MembershipStatus>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: Date | null;
}

export interface AuditLogTable {
  id: Generated<string>;
  tenant_id: string;
  occurred_at: Generated<Date>;
  actor_kind: AuditActorKind;
  actor_id: string | null;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Jsonb<Record<string, unknown>>;
}

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: Generated<Date>;
  applied_by: Generated<string>;
  execution_ms: number;
}

export interface Database {
  tenants: TenantsTable;
  platform_users: PlatformUsersTable;
  tenant_users: TenantUsersTable;
  audit_log: AuditLogTable;
  schema_migrations: SchemaMigrationsTable;
}

/**
 * Tables that legitimately have no `tenant_id`.
 *
 * `tenants` is the tenant; `platform_users` is super-admin identity, which must
 * never be reachable from a tenant request; `schema_migrations` is the
 * migrator's own bookkeeping.
 *
 * Everything else is tenant-scoped, and the schema-invariant suite enforces
 * that: a new table not listed here must carry a non-null `tenant_id` with a
 * foreign key to `tenants(id)`, RLS enabled, and a policy keyed on
 * `app_current_tenant_id()`. Adding a name to this list is how you opt out, and
 * it is a line a reviewer will see.
 */
export const PLATFORM_TABLES = ['tenants', 'platform_users', 'schema_migrations'] as const;

export type PlatformTable = (typeof PLATFORM_TABLES)[number];

/** Tenant-scoped tables: every table in {@link Database} bar {@link PLATFORM_TABLES}. */
export type TenantScopedTable = Exclude<keyof Database, PlatformTable>;

export const TENANT_SCOPED_TABLES = [
  'tenant_users',
  'audit_log',
] as const satisfies readonly TenantScopedTable[];
