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

// ---------------------------------------------------------------------------
// P03 — authentication
// ---------------------------------------------------------------------------

export const CLIENT_APPS = ['web', 'desktop', 'mobile', 'api'] as const;
export const clientAppSchema = z.enum(CLIENT_APPS);
export type ClientApp = z.infer<typeof clientAppSchema>;

export const SESSION_REVOCATION_REASONS = [
  'signed_out',
  'signed_out_everywhere',
  'refresh_token_reuse',
  'revoked_by_admin',
  'membership_ended',
  'impersonation_ended',
  'password_changed',
] as const;
export const sessionRevocationReasonSchema = z.enum(SESSION_REVOCATION_REASONS);
export type SessionRevocationReason = z.infer<typeof sessionRevocationReasonSchema>;

export const OFFLINE_GRANT_REVOCATION_REASONS = [
  'device_lost',
  'revoked_by_admin',
  'session_revoked',
  'membership_ended',
  'replaced',
] as const;
export const offlineGrantRevocationReasonSchema = z.enum(OFFLINE_GRANT_REVOCATION_REASONS);
export type OfflineGrantRevocationReason = z.infer<typeof offlineGrantRevocationReasonSchema>;

export const IMPERSONATION_END_REASONS = [
  'ended_by_admin',
  'expired',
  'revoked_by_tenant',
] as const;
export const impersonationEndReasonSchema = z.enum(IMPERSONATION_END_REASONS);
export type ImpersonationEndReason = z.infer<typeof impersonationEndReasonSchema>;

export const LOGIN_OUTCOMES = [
  'succeeded',
  'bad_credentials',
  'unknown_identity',
  'locked_out',
  'no_membership',
  'rate_limited',
] as const;
export const loginOutcomeSchema = z.enum(LOGIN_OUTCOMES);
export type LoginOutcome = z.infer<typeof loginOutcomeSchema>;

export interface SessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  client_app: ClientApp;
  device_label: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: CreatedAt;
  last_seen_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: SessionRevocationReason | null;
  impersonation_grant_id: string | null;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  tenant_id: string;
  session_id: string;
  token_hash: string;
  issued_at: CreatedAt;
  expires_at: Date;
  used_at: Date | null;
  replaced_by: string | null;
}

export interface OfflineGrantsTable {
  id: Generated<string>;
  tenant_id: string;
  session_id: string;
  user_id: string;
  device_label: string | null;
  issued_at: CreatedAt;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: OfflineGrantRevocationReason | null;
}

export interface InvitationsTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  role: TenantRole;
  token_hash: string;
  invited_by_user_id: string;
  created_at: CreatedAt;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_user_id: string | null;
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
}

export interface ImpersonationGrantsTable {
  id: Generated<string>;
  tenant_id: string;
  platform_user_id: string;
  target_user_id: string;
  reason: string;
  audit_log_id: string;
  created_at: CreatedAt;
  expires_at: Date;
  ended_at: Date | null;
  ended_reason: ImpersonationEndReason | null;
}

export interface LoginAttemptsTable {
  id: Generated<string>;
  email: string;
  ip_address: string | null;
  user_agent: string | null;
  outcome: LoginOutcome;
  occurred_at: Generated<Date>;
}

export interface AccountLocksTable {
  email: string;
  failed_count: Generated<number>;
  last_failure_at: Date | null;
  locked_at: Date | null;
  locked_until: Date | null;
  unlocked_at: Date | null;
  unlocked_by: string | null;
  updated_at: UpdatedAt;
}

/**
 * The `auth_memberships` view: which active companies an identity belongs to.
 *
 * Read-only, and the only object in the schema that deliberately sees across
 * tenants. See migration 0003 for why it exists and why it exposes four
 * columns.
 */
export interface AuthMembershipsView {
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  status: MembershipStatus;
}

// ---------------------------------------------------------------------------
// P04 — API infrastructure
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed'] as const;
export const idempotencyStatusSchema = z.enum(IDEMPOTENCY_STATUSES);
export type IdempotencyStatus = z.infer<typeof idempotencyStatusSchema>;

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'dead'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export interface IdempotencyKeysTable {
  id: Generated<string>;
  tenant_id: string;
  idempotency_key: string;
  user_id: string;
  method: string;
  path: string;
  request_fingerprint: string;
  status: Generated<IdempotencyStatus>;
  response_status: number | null;
  response_body: Jsonb<unknown> | null;
  created_at: CreatedAt;
  completed_at: Date | null;
  expires_at: Date;
}

export interface JobsTable {
  id: Generated<string>;
  tenant_id: string;
  queue: string;
  payload: Jsonb<Record<string, unknown>>;
  status: Generated<JobStatus>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  available_at: Generated<Date>;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  completed_at: Date | null;
  dead_lettered_at: Date | null;
}

export interface RateLimitBucketsTable {
  bucket_key: string;
  window_started_at: Date;
  request_count: Generated<number>;
  updated_at: Generated<Date>;
}

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: Generated<Date>;
  applied_by: Generated<string>;
  execution_ms: number;
}

export const FORM_VERSION_STATUSES = ['draft', 'published'] as const;
export const formVersionStatusSchema = z.enum(FORM_VERSION_STATUSES);
export type FormVersionStatus = z.infer<typeof formVersionStatusSchema>;

export interface FormsTable {
  id: Generated<string>;
  tenant_id: string;
  title: string;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
  fill_roles: Generated<TenantRole[]>;
  signature_required: Generated<boolean>;
  cloned_from_form_id: string | null;
  source_template_key: string | null;
}

export interface FormVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  form_id: string;
  status: Generated<FormVersionStatus>;
  version_number: number | null;
  definition: Jsonb<Record<string, unknown>>;
  definition_schema_version: number;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  published_at: Date | null;
  published_by: string | null;
  revision: Generated<number>;
  change_note: string | null;
  changes: Jsonb<Record<string, unknown>> | null;
}

export const FORM_TEMPLATE_CATEGORIES = ['maintenance', 'safety', 'completion'] as const;
export type FormTemplateCategory = (typeof FORM_TEMPLATE_CATEGORIES)[number];

export interface FormTemplatesTable {
  key: string;
  title: Jsonb<Record<string, string>>;
  description: Jsonb<Record<string, string>>;
  category: FormTemplateCategory;
  definition: Jsonb<Record<string, unknown>>;
  definition_schema_version: number;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SubmissionsTable {
  id: Generated<string>;
  tenant_id: string;
  form_version_id: string;
  answers: Jsonb<Record<string, unknown>>;
  submitted_by: string;
  submitted_at: Generated<Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface Database {
  tenants: TenantsTable;
  platform_users: PlatformUsersTable;
  tenant_users: TenantUsersTable;
  audit_log: AuditLogTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  offline_grants: OfflineGrantsTable;
  invitations: InvitationsTable;
  impersonation_grants: ImpersonationGrantsTable;
  login_attempts: LoginAttemptsTable;
  account_locks: AccountLocksTable;
  idempotency_keys: IdempotencyKeysTable;
  jobs: JobsTable;
  forms: FormsTable;
  form_versions: FormVersionsTable;
  submissions: SubmissionsTable;
  form_templates: FormTemplatesTable;
  rate_limit_buckets: RateLimitBucketsTable;
  schema_migrations: SchemaMigrationsTable;
  auth_memberships: AuthMembershipsView;
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
export const PLATFORM_TABLES = [
  'tenants',
  'platform_users',
  'schema_migrations',
  // Sign-in happens before a company is known — and for an unknown address,
  // before it is knowable. Rate limiting and lockout therefore key on the email
  // across the whole platform. `integr8_app` holds no privilege on either, and
  // the pre-authentication role that does holds nothing else; see 0003.
  'login_attempts',
  'account_locks',
  // Rate limiting runs before the handler and, for an unauthenticated request,
  // before there is any tenant to scope by. Keyed on an opaque bucket string
  // and reached only by the pre-authentication role; see 0004.
  'rate_limit_buckets',
  // The global form template library belongs to no company, and every company
  // may read it. The runtime role holds select and nothing else; see 0007.
  'form_templates',
] as const;

/**
 * Views that read past row-level security, listed so that adding one is a
 * deliberate act.
 *
 * A view created without `security_invoker` runs with its owner's privileges,
 * which makes it the easiest way in the whole schema to hand out a
 * cross-tenant read by accident. The schema-invariant suite fails if a view
 * exists in `public` that is not named here.
 */
export const SECURITY_DEFINER_VIEWS = ['auth_memberships'] as const;
export type SecurityDefinerView = (typeof SECURITY_DEFINER_VIEWS)[number];

/**
 * Functions that run with their owner's privileges, listed for the same reason
 * as the views above. The schema-invariant suite fails if another one appears,
 * or if one of these stops pinning its `search_path`.
 */
export const SECURITY_DEFINER_FUNCTIONS = ['reject_platform_user_membership'] as const;
export type SecurityDefinerFunction = (typeof SECURITY_DEFINER_FUNCTIONS)[number];

export type PlatformTable = (typeof PLATFORM_TABLES)[number];

/**
 * Tenant-scoped tables: every relation in {@link Database} that is neither a
 * platform table nor a view that deliberately reads across companies.
 */
export type TenantScopedTable = Exclude<keyof Database, PlatformTable | SecurityDefinerView>;

/**
 * Written as a record rather than a list so that forgetting a table is a
 * compile error naming it.
 *
 * It used to be a list checked with `satisfies`, which proves every entry is a
 * tenant table and says nothing about whether every tenant table is an entry.
 * P03 and P04 added seven tables and none of them were added here — so the
 * query guard, which builds its set from this constant, was checking two of the
 * nine. Repositories and RLS still covered the other seven, but "three
 * independent controls" was true for two tables. The integration suite found it
 * the first time it ran against a real database.
 */
const TENANT_SCOPED: Readonly<Record<TenantScopedTable, true>> = {
  tenant_users: true,
  audit_log: true,
  sessions: true,
  refresh_tokens: true,
  offline_grants: true,
  invitations: true,
  impersonation_grants: true,
  idempotency_keys: true,
  jobs: true,
  forms: true,
  form_versions: true,
  submissions: true,
};

export const TENANT_SCOPED_TABLES: readonly TenantScopedTable[] = Object.freeze(
  Object.keys(TENANT_SCOPED) as TenantScopedTable[],
);
