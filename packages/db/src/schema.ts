import {
  type ActivityKind,
  type ActivityStatus,
  type CreditNoteStatus,
  type FinanceDocumentKind,
  type InvoiceStoredStatus,
  type PaymentMethod,
  type ItemKind,
  type LocationKind,
  type LocationOwnership,
  type ItemTracking,
  type MovementKind,
  type MaterialStatus,
  type QuoteAnswerVia,
  type QuoteStatus,
  type SalesDocumentKind,
  type SalesOrderStatus,
  type PurchaseOrderStatus,
  type StockCountStatus,
  type SupplierStatus,
  type Unit,
  type LeadSource,
  type LeadStatus,
  type OpportunityEventKind,
  type OpportunityStatus,
  type Role,
  type Grant,
  type ExpenseClaimStatus,
  type ExpenseSettlement,
  type ExpensePaidVia,
  type PayrollRules,
  type PayRunStatus,
  type PayMethod,
  type AssemblyDirection,
  type AssemblyOrderStatus,
  ROLES,
  type StageOutcome,
  type WorkOrderPriority,
  type WorkOrderState,
  type AssetCondition,
  type AssetEventKind,
  type AssetStatus,
  type AccountType,
  type JournalKind,
  type JournalSourceKind,
  type JournalStatus,
  type PeriodEventKind,
  type EtaAttemptKind,
  type EtaAttemptOutcome,
  type EtaDocumentKind,
  type EtaDocumentState,
  type EtaEnvironment,
  type EtaItemType,
  type EtaReceiverType,
  type EtaSigningStatus,
} from '@integr8/core';
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
  /** What the company pays for (0015). Billing itself is P17. */
  plan: Generated<TenantPlan>;
  seats: number | null;
  suspended_at: Date | null;
  /**
   * Non-payment or a lapsed trial (0017), and not the same thing as suspended:
   * reads keep working so a company can still get its data out and pay.
   */
  read_only_since: Date | null;
  read_only_reason: string | null;
  suspended_reason: string | null;
  onboarded_by: string | null;
  /**
   * How the company pays (0021). `self_serve` subscribes in the app through the
   * billing provider; `invoiced` is billed by Integr8 directly, its plan set
   * from the platform dashboard.
   */
  billing_mode: Generated<BillingMode>;
}

export const TENANT_PLANS = ['trial', 'starter', 'standard', 'enterprise'] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

export const BILLING_MODES = ['self_serve', 'invoiced'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const PLATFORM_SESSION_REVOCATION_REASONS = [
  'signed_out',
  'signed_out_everywhere',
  'refresh_token_reuse',
  'account_disabled',
  'password_changed',
] as const;
export type PlatformSessionRevocationReason = (typeof PLATFORM_SESSION_REVOCATION_REASONS)[number];

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const TENANT_EXPORT_STATUSES = ['pending', 'running', 'ready', 'failed'] as const;
export type TenantExportStatus = (typeof TENANT_EXPORT_STATUSES)[number];

/**
 * What a plan does when a company passes its storage allowance (0016).
 *
 * `block` refuses new uploads. `allow` keeps accepting and records the overage
 * on each daily sample, so P17 can bill for it rather than losing the months
 * between here and there.
 */
export const OVERAGE_POLICIES = ['block', 'allow'] as const;
export type OveragePolicy = (typeof OVERAGE_POLICIES)[number];

/** How a night's comparison of the ledger against Cloudflare turned out (0016). */
export const RECONCILIATION_STATUSES = ['matched', 'drifted', 'unavailable'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/**
 * Where a company's subscription stands (0017).
 *
 * The vocabulary is ours rather than any provider's, even though it reads like
 * Stripe's — a regional provider with different words maps onto these, and
 * nothing above the adapter learns which provider is behind them.
 */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export interface PlatformUsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  is_active: Generated<boolean>;
  /** scrypt, as `scrypt$N$r$p$salt$hash`. Null until the account is set up (0015). */
  password_hash: string | null;
  password_changed_at: Date | null;
  /** The TOTP secret, encrypted with PLATFORM_SECRET_KEY. Null until enrolled (0015). */
  totp_secret: string | null;
  totp_enrolled_at: Date | null;
  last_signed_in_at: Date | null;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
  /** True for accounts made by the terminal command; only these add or remove staff (0023). */
  can_manage_staff: Generated<boolean>;
  /** Who added this account from the dashboard. Null for terminal accounts (0023). */
  added_by_platform_user_id: string | null;
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
  /** The company's own role on top of `role` (0041). */
  custom_role_id: Generated<string | null>;
  status: Generated<MembershipStatus>;
  /** Whether this member may use the assistant when the company has it (0044; ADR-0001). */
  ai_enabled: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: Date | null;
}

/** A company's own role (0041; ADR-0013): a built-in base and what it adds or takes away. */
export interface TenantRolesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  base_role: TenantRole;
  added: Generated<string[]>;
  removed: Generated<string[]>;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
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
  /** Set at publish: which answers are copied into submission_values. Null on versions published before 0008. */
  reportable_fields: Jsonb<ReportableFieldSpec[]> | null;
}

export interface ReportableFieldSpec {
  field: string;
  type: ReportableValueType;
  multiple: boolean;
  /** For a field of a repeatable section (P13b): that section. Each entry reports its own rows. */
  section?: string;
}

export const REPORTABLE_VALUE_TYPES = [
  'text',
  'number',
  'date',
  'time',
  'datetime',
  'boolean',
] as const;
export type ReportableValueType = (typeof REPORTABLE_VALUE_TYPES)[number];

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

export const SUBMISSION_STATUSES = ['draft', 'submitted', 'reopened'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * Where a device was when a form was submitted (migration 0012). Coordinates are
 * decimal text, as GPS answers are; `capturedAt` is on the server's clock.
 */
/** Which answers a draft took from its asset's last submission of the same form (0032). */
export interface CarriedOver {
  fromSubmissionId: string;
  /** Question ids, in reading order. */
  fields: string[];
}

export type SubmitLocation =
  | {
      status: 'captured';
      latitude: string;
      longitude: string;
      accuracyMeters?: string | undefined;
      capturedAt: string;
    }
  | { status: 'denied' | 'unavailable' };

export interface SubmissionsTable {
  id: Generated<string>;
  tenant_id: string;
  form_id: string;
  form_version_id: string;
  status: Generated<SubmissionStatus>;
  answers: Jsonb<Record<string, unknown>>;
  /** The person filling it in. */
  submitted_by: string;
  /** Set by trigger when first submitted; null while a draft. */
  submitted_at: Generated<Date | null>;
  amended_at: Generated<Date | null>;
  revision: Generated<number>;
  /** Who is making this change. Required on every write; the history trigger records it. */
  last_actor: string;
  last_reason: string | null;
  /** Generated full-text vector. Never written. */
  search: ColumnType<string, never, never>;
  /** The job this form was filled for. Set at insert; the database refuses a change. */
  work_order_id: ColumnType<string | null, string | null | undefined, never>;
  /** The asset this form was filled for (0031): one of the job's assets. */
  asset_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Answers taken from the asset's last submission of the form (0032). Set at insert. */
  carried_over: ColumnType<CarriedOver | null, CarriedOver | null | undefined, never>;
  /** Written only by submitting; see {@link SubmitLocation}. */
  submit_location: ColumnType<
    SubmitLocation | null,
    SubmitLocation | null | undefined,
    SubmitLocation | null
  >;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export const SUBMISSION_EVENT_KINDS = ['submitted', 'reopened', 'amended'] as const;
export type SubmissionEventKind = (typeof SUBMISSION_EVENT_KINDS)[number];

/** Written only by trigger; the runtime role may read it. */
export interface SubmissionEventsTable {
  id: ColumnType<string, never, never>;
  tenant_id: ColumnType<string, never, never>;
  submission_id: ColumnType<string, never, never>;
  sequence: ColumnType<number, never, never>;
  kind: ColumnType<SubmissionEventKind, never, never>;
  answers: ColumnType<Record<string, unknown> | null, never, never>;
  actor_id: ColumnType<string, never, never>;
  reason: ColumnType<string | null, never, never>;
  location: ColumnType<SubmitLocation | null, never, never>;
  occurred_at: ColumnType<Date, never, never>;
}

/** Written only by trigger; the runtime role may read it. */
export interface SubmissionValuesTable {
  tenant_id: ColumnType<string, never, never>;
  submission_id: ColumnType<string, never, never>;
  form_id: ColumnType<string, never, never>;
  form_version_id: ColumnType<string, never, never>;
  field_id: ColumnType<string, never, never>;
  /** For a field of a repeatable section: the entry's id. Null otherwise (0014). */
  entry_id: ColumnType<string | null, never, never>;
  /** For a field of a repeatable section: the entry's position when submitted. 0 otherwise. */
  entry_index: ColumnType<number, never, never>;
  ordinal: ColumnType<number, never, never>;
  value_type: ColumnType<ReportableValueType, never, never>;
  value_text: ColumnType<string | null, never, never>;
  value_number: ColumnType<string | null, never, never>;
  value_date: ColumnType<Date | null, never, never>;
  value_time: ColumnType<string | null, never, never>;
  value_timestamp: ColumnType<Date | null, never, never>;
  value_boolean: ColumnType<boolean | null, never, never>;
  submitted_at: ColumnType<Date, never, never>;
}

export const MEDIA_CATEGORIES = ['image', 'video', 'document', 'other'] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];

/** Media categories, plus thumbnails, which occupy the bucket too. */
export const USAGE_CATEGORIES = [...MEDIA_CATEGORIES, 'thumbnail'] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export const STORAGE_PROVIDERS = ['local', 'r2'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const THUMBNAIL_STATUSES = ['none', 'pending', 'ready', 'failed'] as const;
export type ThumbnailStatus = (typeof THUMBNAIL_STATUSES)[number];

/** bigint columns: the driver returns them as text. */
type BigIntColumn = ColumnType<string, number, number>;
/** A bigint with a database default: a counter that starts at zero (0044). */
type GeneratedBigInt = ColumnType<string, number | undefined, number>;

export interface TenantStorageTable {
  tenant_id: string;
  provider: StorageProvider;
  bucket: string;
  provisioned_at: CreatedAt;
  purged_at: Date | null;
}

export interface UploadIntentsTable {
  id: Generated<string>;
  tenant_id: string;
  bucket: string;
  storage_key: string;
  content_type: string;
  declared_bytes: BigIntColumn;
  category: MediaCategory;
  created_by: string;
  created_at: CreatedAt;
  expires_at: Date;
  /** Set when the bytes arrive in parts (P12). */
  multipart_upload_id: string | null;
  part_size: number | null;
}

export interface FilesTable {
  id: string;
  tenant_id: string;
  bucket: string;
  storage_key: string;
  byte_size: BigIntColumn;
  etag: string | null;
  content_type: string;
  category: MediaCategory;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  uploaded_by: string;
  created_at: CreatedAt;
  thumbnail_status: Generated<ThumbnailStatus>;
  thumbnail_key: string | null;
  thumbnail_bytes: ColumnType<string | null, number | null, number | null>;
  deleted_at: Date | null;
  deleted_by: string | null;
  purge_after: Date | null;
  purged_at: Date | null;
}

/** Written only by trigger; the runtime role may read it. */
export interface TenantStorageUsageTable {
  tenant_id: ColumnType<string, never, never>;
  category: ColumnType<UsageCategory, never, never>;
  bytes: ColumnType<string, never, never>;
  objects: ColumnType<number, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// ---------------------------------------------------------------------------
// Storage metering and quotas (0016)
// ---------------------------------------------------------------------------

export interface PlanAllowancesTable {
  plan: TenantPlan;
  /** Null is uncapped. */
  storage_bytes: ColumnType<string | null, number | null, number | null>;
  /** The rest of what a plan allows (0017). Null is uncapped, as above. */
  seats: number | null;
  submissions_per_month: number | null;
  /** What it costs, for a screen to show. The provider does the arithmetic. */
  price_cents: number | null;
  currency: string | null;
  provider_price_monthly: string | null;
  provider_price_yearly: string | null;
  /** How long media is kept before the retention job takes it. Null is for ever. */
  retention_days: number | null;
  overage: Generated<OveragePolicy>;
  warn_at_percent: Generated<number>;
  updated_at: UpdatedAt;
  updated_by: string | null;
}

export interface TenantStorageSamplesTable {
  tenant_id: string;
  /** The day, not the moment: one row per company per day. */
  sampled_on: ColumnType<string, string, never>;
  bytes: BigIntColumn;
  objects: number;
  /** Bytes per category on the day. */
  by_category: Generated<Jsonb<Record<string, number>>>;
  /**
   * The allowance that applied on the day, copied rather than joined: an
   * allowance edited next month must not rewrite last month's overage.
   */
  allowance_bytes: ColumnType<string | null, number | null, number | null>;
  overage_bytes: ColumnType<string | null, number | null, number | null>;
  class_a_operations: ColumnType<string | null, number | null, number | null>;
  class_b_operations: ColumnType<string | null, number | null, number | null>;
}

export interface StorageReconciliationsTable {
  id: Generated<string>;
  tenant_id: string;
  ran_at: CreatedAt;
  ledger_bytes: BigIntColumn;
  ledger_objects: number;
  cloudflare_bytes: ColumnType<string | null, number | null, number | null>;
  cloudflare_objects: number | null;
  cloudflare_sampled_at: Date | null;
  /** Signed: positive means the ledger claims more than Cloudflare reports. */
  drift_bytes: ColumnType<string | null, number | null, number | null>;
  status: ReconciliationStatus;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Subscriptions and billing (0017)
// ---------------------------------------------------------------------------

export interface SubscriptionsTable {
  tenant_id: string;
  provider: string;
  /** Null until a checkout completes: a company on a trial has neither yet. */
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: Generated<SubscriptionStatus>;
  plan: Generated<TenantPlan>;
  billing_interval: BillingInterval | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: Generated<boolean>;
  trial_ends_at: Date | null;
  /** Dunning: when the card first failed, and when read-only arrives. */
  past_due_since: Date | null;
  grace_ends_at: Date | null;
  reminders_sent: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BillingEventsTable {
  id: Generated<string>;
  provider: string;
  /** The provider's id for the delivery. Unique, which is the whole dedupe. */
  provider_event_id: string;
  type: string;
  /** Null when the event names a customer this deployment does not know. */
  tenant_id: string | null;
  payload: Jsonb<Record<string, unknown>>;
  received_at: CreatedAt;
  processed_at: Date | null;
  error: string | null;
}

export interface ScheduledTaskRunsTable {
  task: string;
  last_run_at: Generated<Date>;
  last_finished_at: Date | null;
  claimed_by: string | null;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Self-serve onboarding (0018)
// ---------------------------------------------------------------------------

/**
 * `verifying` (0020) is the claim: one verify has taken the request and is
 * provisioning the company. It lasts seconds, and a failure puts the request
 * back to `pending` so the link still works.
 */
export const SIGNUP_STATUSES = [
  'pending',
  'verifying',
  'verified',
  'expired',
  'abandoned',
] as const;
export type SignupStatus = (typeof SIGNUP_STATUSES)[number];

export interface SignupRequestsTable {
  id: Generated<string>;
  email: string;
  company_name: string;
  /** Only the hash is stored: holding the token grants a company. */
  token_hash: string;
  status: Generated<SignupStatus>;
  expires_at: Date;
  verified_at: Date | null;
  /** The company this request created, once it has created one. */
  tenant_id: string | null;
  /** How many times the link has been sent again (0019). Capped by the service. */
  resend_count: Generated<number>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SignupEventsTable {
  id: Generated<string>;
  /** Free text on purpose: a migration to add a funnel step is one nobody writes. */
  step: string;
  signup_id: string | null;
  tenant_id: string | null;
  metadata: Generated<Jsonb<Record<string, unknown>>>;
  occurred_at: CreatedAt;
}

/** The theme a company's apps open in (0022). People in the company do not choose. */
export const COMPANY_THEMES = ['light', 'dark', 'system'] as const;
export const companyThemeSchema = z.enum(COMPANY_THEMES);
export type CompanyTheme = z.infer<typeof companyThemeSchema>;

export interface TenantSettingsTable {
  tenant_id: string;
  logo_media_id: string | null;
  brand_colour: string | null;
  /** The dashboard shell colour, `#RRGGBB` (0022). Null means the product default. */
  shell_colour: string | null;
  default_theme: Generated<CompanyTheme>;
  /** The company's own website, https only (0022). */
  website_url: string | null;
  /** A square image for the installer and phone icons (0022). */
  app_icon_media_id: string | null;
  /** Whether the release pipeline builds this company's own apps (0022). */
  apps_enabled: Generated<boolean>;
  /** An IANA name. What a working day means for this company. */
  timezone: Generated<string>;
  currency: Generated<string>;
  locale: Generated<string>;
  /** Minutes from midnight, in the company's own timezone. */
  work_day_starts: Generated<number>;
  work_day_ends: Generated<number>;
  /** ISO weekday numbers; 1 is Monday. Empty means the company is closed. */
  working_days: Generated<number[]>;
  /** Which of the company's apps show the assistant (0044; ADR-0001). Narrow the platform grant only. */
  ai_web_enabled: Generated<boolean>;
  ai_desktop_enabled: Generated<boolean>;
  ai_mobile_enabled: Generated<boolean>;
  website_files_enabled: Generated<boolean>;
  website_jobs_enabled: Generated<boolean>;
  website_quotes_enabled: Generated<boolean>;
  website_invoices_enabled: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// ---------------------------------------------------------------------------
// Customers, sites and work orders (0010)
// ---------------------------------------------------------------------------

export const CUSTOMER_STATUSES = ['active', 'on_hold', 'closed'] as const;
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);
export type CustomerStatus = z.infer<typeof customerStatusSchema>;

export const GEOCODE_STATUSES = ['pending', 'found', 'not_found', 'failed', 'manual'] as const;
export type GeocodeStatus = (typeof GEOCODE_STATUSES)[number];

export const ATTACHMENT_KINDS = ['site_plan', 'manual', 'report', 'photo', 'other'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** When a job photo was taken (0013). */
export const PHOTO_STAGES = ['before', 'after'] as const;
export type PhotoStage = (typeof PHOTO_STAGES)[number];

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const PUSH_DISABLED_REASONS = ['signed_out', 'not_registered', 'replaced'] as const;
export type PushDisabledReason = (typeof PUSH_DISABLED_REASONS)[number];

export const COMMENT_VISIBILITIES = ['internal', 'customer'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export const IMPORT_KINDS = ['customers', 'sites', 'work_orders', 'assets'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const WORK_ORDER_EVENT_KINDS = [
  'created',
  'transitioned',
  'rescheduled',
  'updated',
  'assigned',
  'unassigned',
  'lead_changed',
  'signed_off',
] as const;
export type WorkOrderEventKind = (typeof WORK_ORDER_EVENT_KINDS)[number];

/** Numeric columns come back from pg as strings, to keep their precision. */
type Coordinate = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;

interface AddressColumns {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country_code: string | null;
}

export interface CustomersTable extends AddressColumns {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  account_number: string | null;
  status: Generated<CustomerStatus>;
  email: string | null;
  phone: string | null;
  tags: Generated<string[]>;
  notes: string | null;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  search: ColumnType<string, never, never>;
  /** Sample data loaded at onboarding (0018), removable in one action. */
  is_demo: Generated<boolean>;
}

/**
 * A prospect that is not a customer yet (0024, CRM phase F1). Converts once
 * into a customer; archived, never deleted.
 */
export interface CrmLeadsTable {
  id: Generated<string>;
  tenant_id: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  source: Generated<LeadSource>;
  status: Generated<LeadStatus>;
  assigned_to: string | null;
  /** `numeric(20,4)`, which node-postgres returns as a string: never a JavaScript number. */
  estimated_value: string | null;
  currency_code: string | null;
  notes: string | null;
  unqualified_reason: string | null;
  converted_customer_id: string | null;
  converted_contact_id: string | null;
  converted_at: Date | null;
  converted_by: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
  email_normalized: ColumnType<string | null, never, never>;
  phone_digits: ColumnType<string | null, never, never>;
  search: ColumnType<string, never, never>;
}

export interface CrmPipelinesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  is_default: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
}

export interface CrmPipelineStagesTable {
  id: Generated<string>;
  tenant_id: string;
  pipeline_id: string;
  key: string;
  label: string;
  position: number;
  probability_bp: number;
  outcome: StageOutcome;
  created_at: CreatedAt;
  archived_at: Date | null;
}

export interface CrmOpportunitiesTable {
  id: Generated<string>;
  tenant_id: string;
  title: string;
  customer_id: string | null;
  lead_id: string | null;
  pipeline_id: string;
  stage_id: string;
  owner_id: string | null;
  /** `numeric(20,4)`, which node-postgres returns as a string: never a JavaScript number. */
  amount: string | null;
  currency_code: string;
  /** A calendar date (`date`), read as `YYYY-MM-DD` text: no time zone to shift it. */
  expected_close_date: ColumnType<string | null, string | null, string | null>;
  probability_bp: number;
  status: Generated<OpportunityStatus>;
  lost_reason: string | null;
  description: string | null;
  closed_at: Date | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
  search: ColumnType<string, never, never>;
}

export interface CrmOpportunityEventsTable {
  id: Generated<string>;
  tenant_id: string;
  opportunity_id: string;
  kind: OpportunityEventKind;
  from_stage_id: string | null;
  to_stage_id: string | null;
  from_status: OpportunityStatus | null;
  to_status: OpportunityStatus | null;
  reason: string | null;
  actor_id: string;
  occurred_at: CreatedAt;
}

/** Each amount or currency an opportunity has had (0043; ADR-0013). Written by trigger. */
export interface CrmOpportunityAmountsTable {
  id: ColumnType<string, never, never>;
  tenant_id: ColumnType<string, never, never>;
  opportunity_id: ColumnType<string, never, never>;
  amount: ColumnType<string | null, never, never>;
  currency_code: ColumnType<string, never, never>;
  baseline: ColumnType<boolean, never, never>;
  changed_at: ColumnType<Date, never, never>;
}

export interface CrmActivitiesTable {
  id: Generated<string>;
  tenant_id: string;
  kind: ActivityKind;
  subject: string;
  detail: string | null;
  outcome: string | null;
  status: Generated<ActivityStatus>;
  assigned_to: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  completed_by: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface CrmActivityLeadsTable {
  tenant_id: string;
  activity_id: string;
  lead_id: string;
}

export interface CrmActivityCustomersTable {
  tenant_id: string;
  activity_id: string;
  customer_id: string;
}

export interface CrmActivityOpportunitiesTable {
  tenant_id: string;
  activity_id: string;
  opportunity_id: string;
}

export interface ErpItemCategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
}

export interface ErpItemsTable {
  id: Generated<string>;
  tenant_id: string;
  sku: string;
  name: string;
  description: string | null;
  kind: Generated<ItemKind>;
  category_id: string | null;
  unit: Generated<Unit>;
  barcode: string | null;
  /** `numeric(20,4)`, read as a string. */
  default_unit_cost: string | null;
  sale_price: string | null;
  average_unit_cost: Generated<string>;
  preferred_supplier_id: string | null;
  supplier_part_number: string | null;
  /** Days to build or to arrive (0039). */
  lead_time_days: number | null;
  /** How its units are told apart (0042). */
  tracking: Generated<ItemTracking>;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
  search: ColumnType<string, never, never>;
}

export interface ErpStockLocationsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  kind: LocationKind;
  assigned_to: string | null;
  site_id: string | null;
  notes: string | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: Date | null;
  /** Whose stock it holds (0040). */
  ownership: Generated<LocationOwnership>;
}

export interface ErpStockCountsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  status: Generated<StockCountStatus>;
  notes: string | null;
  version: Generated<number>;
  created_by: string;
  posted_by: string | null;
  posted_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpStockCountLinesTable {
  tenant_id: string;
  count_id: string;
  item_id: string;
  counted_quantity: string;
  expected_quantity: string | null;
  /** The serial or batch counted, for a tracked item (0042). */
  lot_id: Generated<string | null>;
  /** A serial or batch the company has not seen before, created when the count is posted. */
  lot_code: Generated<string | null>;
  lot_expires_on: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A serial number or batch of a tracked item (0042; ADR-0013). */
export interface ErpStockLotsTable {
  id: Generated<string>;
  tenant_id: string;
  item_id: string;
  kind: 'serial' | 'batch';
  code: string;
  /** A calendar date, read as `YYYY-MM-DD` text. */
  expires_on: ColumnType<string | null, string | null | undefined, never>;
  created_by: string;
  created_at: CreatedAt;
}

export interface ErpStockLotBalancesTable {
  tenant_id: string;
  lot_id: string;
  location_id: string;
  item_id: string;
  on_hand: string;
  updated_at: CreatedAt;
}

export interface ErpStockMovementsTable {
  id: Generated<string>;
  tenant_id: string;
  posting_id: string;
  item_id: string;
  location_id: string;
  kind: MovementKind;
  /** Signed `numeric(20,4)`, read as a string. */
  quantity: string;
  unit_cost: string | null;
  source_key: string;
  reason: string | null;
  stock_count_id: string | null;
  reversal_of: string | null;
  actor_id: string;
  occurred_at: CreatedAt;
  /** The serial or batch moved, for a tracked item (0042). */
  lot_id: Generated<string | null>;
}

export interface ErpStockBalancesTable {
  tenant_id: string;
  item_id: string;
  location_id: string;
  on_hand: string;
  updated_at: UpdatedAt;
}

export interface ErpReorderLevelsTable {
  tenant_id: string;
  item_id: string;
  location_id: string;
  minimum: string;
}

export interface ErpSuppliersTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  tax_reference: string | null;
  payment_terms: string | null;
  lead_time_days: number | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country_code: string | null;
  status: Generated<SupplierStatus>;
  notes: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  search: ColumnType<string, never, never>;
}

export interface ErpPurchaseOrderCountersTable {
  tenant_id: string;
  last_reference: number;
}

export interface ErpPurchaseOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number>;
  supplier_id: string;
  supplier_name: string;
  status: Generated<PurchaseOrderStatus>;
  currency_code: string;
  /** A calendar date, read as `YYYY-MM-DD` text. */
  expected_date: ColumnType<string | null, string | null, string | null>;
  delivery_location_id: string | null;
  notes: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpPurchaseOrderLinesTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  position: number;
  item_id: string;
  description: string;
  quantity_ordered: string;
  quantity_received: Generated<string>;
  unit_price: string;
  tax_rate_bp: Generated<number>;
}

export interface ErpGoodsReceiptsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  location_id: string;
  supplier_note: string | null;
  notes: string | null;
  received_by: string;
  received_at: CreatedAt;
}

export interface ErpGoodsReceiptLinesTable {
  id: Generated<string>;
  tenant_id: string;
  receipt_id: string;
  order_line_id: string;
  quantity: string;
  unit_cost: string;
  returned_quantity: Generated<string>;
}

/** A part used on a job (CRM/ERP plan, phase E2; ADR-0005). */
export interface ErpWorkOrderMaterialsTable {
  id: Generated<string>;
  tenant_id: string;
  work_order_id: string;
  item_id: string;
  location_id: string | null;
  quantity: string;
  returned_quantity: Generated<string>;
  unit_cost: string | null;
  status: Generated<MaterialStatus>;
  available_quantity: string | null;
  client_action_id: string | null;
  note: string | null;
  recorded_by: string;
  recorded_at: CreatedAt;
  occurred_at: Generated<Date>;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  version: Generated<number>;
  /** The asset the part was fitted to (0031). */
  asset_id: Generated<string | null>;
  /** The serial numbers or batches the part came from, as asked for (0042). */
  lots: Jsonb<MaterialLot[] | null>;
}

/** A serial number or batch a part came from: the lot and how much of it. */
export interface MaterialLot {
  lotId: string;
  quantity: string;
}

// ---------------------------------------------------------------------------
// Quotes and sales orders (0029; CRM/ERP plan, phase S1)
// ---------------------------------------------------------------------------

export interface SalesDocumentCountersTable {
  tenant_id: string;
  kind: SalesDocumentKind;
  last_reference: number;
}

export interface CrmQuotesTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number>;
  revision: Generated<number>;
  customer_id: string;
  site_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  status: Generated<QuoteStatus>;
  title: string;
  currency_code: string;
  /** A calendar date, read as `YYYY-MM-DD` text. */
  valid_until: ColumnType<string | null, string | null, string | null>;
  introduction: string | null;
  terms: string | null;
  internal_notes: string | null;
  customer_name: string | null;
  customer_address: Jsonb<Record<string, string | null>> | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  issued_by: string | null;
  issued_at: Date | null;
  access_token_hash: string | null;
  answered_at: Date | null;
  answered_by: string | null;
  answered_via: QuoteAnswerVia | null;
  answered_name: string | null;
  answered_from: string | null;
  rejection_reason: string | null;
  converted_order_id: string | null;
  converted_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface CrmQuoteLinesTable {
  id: Generated<string>;
  tenant_id: string;
  quote_id: string;
  position: number;
  item_id: string | null;
  description: string;
  quantity: string;
  unit: Generated<Unit>;
  unit_price: string;
  discount_bp: Generated<number>;
  tax_rate_bp: Generated<number>;
}

export interface ErpSalesOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number>;
  quote_id: string | null;
  customer_id: string;
  site_id: string | null;
  contact_id: string | null;
  status: Generated<SalesOrderStatus>;
  title: string;
  currency_code: string;
  notes: string | null;
  internal_notes: string | null;
  reserve_location_id: string | null;
  customer_name: string | null;
  customer_address: Jsonb<Record<string, string | null>> | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  fulfilled_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpSalesOrderLinesTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  position: number;
  item_id: string | null;
  description: string;
  quantity: string;
  unit: Generated<Unit>;
  unit_price: string;
  discount_bp: Generated<number>;
  tax_rate_bp: Generated<number>;
  quantity_reserved: Generated<string>;
  reserve_location_id: string | null;
  quantity_fulfilled: Generated<string>;
}

export interface ErpSalesOrderWorkOrdersTable {
  tenant_id: string;
  order_id: string;
  work_order_id: string;
  linked_by: string;
  linked_at: CreatedAt;
}

/** A company's invoice issuer details and labour rates (0030, CRM/ERP plan B1). */
export interface ErpFinanceSettingsTable {
  tenant_id: string;
  legal_name: string | null;
  address: string | null;
  tax_reference: string | null;
  payment_instructions: string | null;
  footer: string | null;
  default_due_days: Generated<number>;
  labour_hourly_cost: string | null;
  labour_hourly_rate: string | null;
  version: Generated<number>;
  updated_by: string | null;
  updated_at: UpdatedAt;
}

export interface FinanceDocumentCountersTable {
  tenant_id: string;
  kind: FinanceDocumentKind;
  last_reference: number;
}

export interface ErpInvoicesTable {
  id: Generated<string>;
  tenant_id: string;
  /** Given by trigger when issued. */
  reference: Generated<number | null>;
  customer_id: string;
  site_id: string | null;
  contact_id: string | null;
  sales_order_id: string | null;
  work_order_id: string | null;
  status: Generated<InvoiceStoredStatus>;
  currency_code: string;
  issue_date: string | Date | null;
  due_date: string | Date | null;
  notes: string | null;
  internal_notes: string | null;
  customer_name: string | null;
  customer_address: Jsonb<Record<string, string | null>> | null;
  contact_name: string | null;
  contact_email: string | null;
  issuer: Jsonb<Record<string, string | null>> | null;
  issued_by: string | null;
  issued_at: Date | null;
  voided_by: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpInvoiceLinesTable {
  id: Generated<string>;
  tenant_id: string;
  invoice_id: string;
  position: number;
  item_id: string | null;
  description: string;
  quantity: string;
  unit: Generated<Unit>;
  unit_price: string;
  discount_bp: Generated<number>;
  tax_rate_bp: Generated<number>;
  sales_order_line_id: string | null;
  work_order_material_id: string | null;
}

export interface ErpCreditNotesTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number | null>;
  invoice_id: string;
  status: Generated<CreditNoteStatus>;
  reason: string;
  issue_date: string | Date | null;
  issued_by: string | null;
  issued_at: Date | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpCreditNoteLinesTable {
  id: Generated<string>;
  tenant_id: string;
  credit_note_id: string;
  position: number;
  invoice_line_id: string | null;
  item_id: string | null;
  description: string;
  quantity: string;
  unit: Generated<Unit>;
  unit_price: string;
  discount_bp: Generated<number>;
  tax_rate_bp: Generated<number>;
}

export interface ErpPaymentReceiptsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Given by trigger when recorded. */
  reference: Generated<number | null>;
  customer_id: string;
  received_on: string | Date;
  amount: string;
  currency_code: string;
  method: PaymentMethod;
  payment_reference: string | null;
  notes: string | null;
  recorded_by: string;
  recorded_at: CreatedAt;
}

export interface ErpPaymentAllocationsTable {
  id: Generated<string>;
  tenant_id: string;
  receipt_id: string;
  invoice_id: string;
  amount: string;
  allocated_by: string;
  allocated_at: CreatedAt;
  removed_by: string | null;
  removed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Assets (0031; CRM/ERP plan, phase E3; ADR-0008)
// ---------------------------------------------------------------------------

export interface ErpAssetSettingsTable {
  tenant_id: string;
  warranty_alert_days: Generated<number>;
  version: Generated<number>;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface AssetReferenceCountersTable {
  tenant_id: string;
  last_reference: number;
}

export interface ErpAssetsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Given by trigger on insert. */
  reference: Generated<number>;
  customer_id: string;
  site_id: string;
  item_id: string | null;
  name: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  location_note: string | null;
  /** `YYYY-MM-DD`. */
  install_date: ColumnType<string | null, string | null | undefined, string | null>;
  /** `YYYY-MM-DD`. */
  warranty_expires_on: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<AssetStatus>;
  condition: AssetCondition | null;
  condition_recorded_at: Date | null;
  condition_recorded_by: string | null;
  tag_code: string;
  notes: string | null;
  client_action_id: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
  retired_at: Date | null;
  retired_by: string | null;
}

export interface ErpAssetEventsTable {
  id: Generated<string>;
  tenant_id: string;
  asset_id: string;
  kind: AssetEventKind;
  from_customer_id: string | null;
  from_site_id: string | null;
  from_status: AssetStatus | null;
  to_status: AssetStatus | null;
  condition: AssetCondition | null;
  changes: ColumnType<Record<string, [unknown, unknown]> | null, string | null | undefined, never>;
  work_order_id: string | null;
  note: string | null;
  actor_id: string;
  occurred_at: Generated<Date>;
  recorded_at: CreatedAt;
  client_action_id: string | null;
}

export interface ErpWorkOrderAssetsTable {
  tenant_id: string;
  work_order_id: string;
  asset_id: string;
  linked_by: string;
  linked_at: CreatedAt;
}

// ---------------------------------------------------------------------------
// The general ledger (0033; CRM/ERP plan, phase A1; ADR-0009)
// ---------------------------------------------------------------------------

export interface ErpLedgerAccountsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  type: AccountType;
  archived_at: Date | null;
  archived_by: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface ErpLedgerSettingsTable {
  tenant_id: string;
  /** `YYYY-MM-01`. */
  start_date: string;
  fiscal_start_month: Generated<number>;
  auto_post_sales: Generated<boolean>;
  auto_post_stock: Generated<boolean>;
  auto_post_expenses: Generated<boolean>;
  auto_post_payroll: Generated<boolean>;
  allow_self_approval: Generated<boolean>;
  receivables_account_id: string;
  revenue_services_account_id: string;
  revenue_goods_account_id: string;
  vat_output_account_id: string;
  cash_account_id: string;
  bank_account_id: string;
  other_receipts_account_id: string;
  inventory_account_id: string;
  goods_received_account_id: string;
  parts_cost_account_id: string;
  stock_adjustments_account_id: string;
  opening_balances_account_id: string;
  retained_earnings_account_id: string;
  staff_claims_payable_account_id: string;
  staff_expenses_account_id: string;
  salaries_expense_account_id: string;
  employer_insurance_expense_account_id: string;
  salaries_payable_account_id: string;
  payroll_tax_payable_account_id: string;
  social_insurance_payable_account_id: string;
  martyrs_fund_payable_account_id: string;
  assembly_absorbed_account_id: string;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface ErpLedgerPeriodsTable {
  tenant_id: string;
  /** `YYYY-MM-01`. */
  period_start: string;
  locked: boolean;
  changed_by: string;
  changed_at: Generated<Date>;
}

export interface ErpLedgerPeriodEventsTable {
  id: Generated<string>;
  tenant_id: string;
  period_start: string;
  kind: PeriodEventKind;
  reason: string | null;
  actor_id: string;
  occurred_at: Generated<Date>;
}

export interface JournalReferenceCountersTable {
  tenant_id: string;
  last_reference: number;
}

export interface ErpJournalsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Given by trigger when posted. */
  reference: ColumnType<number | null, never, never>;
  status: Generated<JournalStatus>;
  kind: JournalKind;
  /** `YYYY-MM-DD`. */
  entry_date: string;
  memo: string | null;
  source_kind: JournalSourceKind | null;
  source_id: string | null;
  reversal_of: string | null;
  foreign_currency: string | null;
  /** Up to ten places, as text. */
  exchange_rate: string | null;
  rate_source: string | null;
  drafted_by: string;
  drafted_at: Generated<Date>;
  posted_by: string | null;
  posted_at: Date | null;
  self_approved: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface ErpJournalLinesTable {
  id: Generated<string>;
  tenant_id: string;
  journal_id: string;
  line_no: number;
  account_id: string;
  /** Decimal string. */
  debit: Generated<string>;
  /** Decimal string. */
  credit: Generated<string>;
  memo: string | null;
  customer_id: string | null;
  foreign_amount: string | null;
}

export const LEDGER_POSTING_STATUSES = ['pending', 'posted', 'skipped'] as const;
export type LedgerPostingStatus = (typeof LEDGER_POSTING_STATUSES)[number];
/** Why a captured document waits in the unposted list. */
export const LEDGER_POSTING_REASONS = [
  'queued',
  'auto_off',
  'before_set_up',
  'foreign_currency',
  'cost_unknown',
  'period_locked',
  'waits_for_invoice',
  'failed',
] as const;
export type LedgerPostingReason = (typeof LEDGER_POSTING_REASONS)[number];

export interface ErpLedgerPostingsTable {
  id: Generated<string>;
  tenant_id: string;
  source_kind: JournalSourceKind;
  source_id: string;
  /** `YYYY-MM-DD`. */
  document_date: string;
  currency: string;
  status: Generated<LedgerPostingStatus>;
  reason: LedgerPostingReason | null;
  detail: string | null;
  journal_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  skip_reason: string | null;
  captured_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface ErpLedgerYearClosesTable {
  id: Generated<string>;
  tenant_id: string;
  /** `YYYY-MM-01`. */
  year_start: string;
  closing_journal_id: string;
  closed_by: string;
  closed_at: Generated<Date>;
  reopened_by: string | null;
  reopened_at: Date | null;
  reopen_reason: string | null;
  reopening_journal_id: string | null;
}

/** Capabilities on top of a member's role (0036; ADR-0010). */
export interface MemberGrantsTable {
  tenant_id: string;
  user_id: string;
  capability: Grant;
  granted_by: string;
  granted_at: Generated<Date>;
}

/** Employee profiles (0036; ADR-0010). Sealed columns hold API-written ciphertext. */
export interface HrEmployeesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string | null;
  employee_number: string | null;
  full_name: string;
  job_title: string | null;
  department: string | null;
  phone: string | null;
  hire_date: string | Date;
  end_date: string | Date | null;
  end_reason: string | null;
  national_id_sealed: string | null;
  national_id_last4: string | null;
  insurance_number_sealed: string | null;
  insurance_number_last4: string | null;
  bank_name: string | null;
  bank_account_sealed: string | null;
  bank_account_last4: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Expense categories (0037; ADR-0010). */
export interface HrExpenseCategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  account_id: string | null;
  archived_at: Date | null;
  version: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExpenseReferenceCountersTable {
  tenant_id: string;
  last_reference: number;
}

/** Staff expense claims (0037; ADR-0010). */
export interface HrExpenseClaimsTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number>;
  claimant_id: string;
  category_id: string;
  work_order_id: string | null;
  spent_on: string | Date;
  amount: string;
  currency: string;
  description: string;
  status: Generated<ExpenseClaimStatus>;
  client_action_id: string | null;
  submitted_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
  reject_reason: string | null;
  settle_via: ExpenseSettlement | null;
  paid_via: ExpensePaidVia | null;
  paid_by: string | null;
  paid_at: Date | null;
  payment_reference: string | null;
  payroll_run_id: string | null;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

/** Payroll figures from a month on (0038; ADR-0010); frozen once confirmed. */
export interface HrPayrollRuleSetsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  effective_from: string | Date;
  rules: Jsonb<PayrollRules>;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  confirmation_note: string | null;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  version: Generated<number>;
}

/** An employee's pay from a date on (0038). */
export interface HrPayTermsTable {
  id: Generated<string>;
  tenant_id: string;
  employee_id: string;
  effective_from: string | Date;
  basic: string;
  allowances: Generated<string>;
  insured: Generated<boolean>;
  insurable_wage: string | null;
  standard_hours: Generated<string>;
  overtime_rate: string | null;
  pay_method: Generated<PayMethod>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  version: Generated<number>;
}

/** A month's pay run (0038). */
export interface HrPayrollRunsTable {
  id: Generated<string>;
  tenant_id: string;
  period_start: string | Date;
  period_end: string | Date;
  rule_set_id: string;
  currency: string;
  status: Generated<PayRunStatus>;
  pay_date: string | Date | null;
  note: string | null;
  prepared_by: string;
  prepared_at: Generated<Date>;
  approved_by: string | null;
  approved_at: Date | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** One employee's pay in a run: what went in, and what came out (0038). */
export interface HrPayrollLinesTable {
  id: Generated<string>;
  tenant_id: string;
  run_id: string;
  employee_id: string;
  basic: string;
  allowances: string;
  clocked_hours: Generated<string>;
  overtime_hours: Generated<string>;
  overtime_rate: Generated<string>;
  bonus: Generated<string>;
  deduction: Generated<string>;
  unpaid_days: Generated<string>;
  reimbursements: Generated<string>;
  declared_insurable_wage: string | null;
  insured: boolean;
  pay_method: PayMethod;
  note: string | null;
  overtime_pay: string;
  unpaid_leave: string;
  gross: string;
  insurable_wage: string;
  si_employee: string;
  si_employer: string;
  taxable: string;
  income_tax: string;
  martyrs_fund: string;
  net: string;
  version: Generated<number>;
  updated_at: UpdatedAt;
}

/** A bill of materials version (0039; ADR-0011). */
export interface ErpBomsTable {
  id: Generated<string>;
  tenant_id: string;
  item_id: string;
  version: number;
  labour_cost: Generated<string>;
  overhead_cost: Generated<string>;
  note: string | null;
  created_by: string;
  created_at: CreatedAt;
  superseded_at: Date | null;
  superseded_by: string | null;
}

export interface ErpBomComponentsTable {
  tenant_id: string;
  bom_id: string;
  line_no: number;
  item_id: string;
  quantity: string;
}

export interface AssemblyReferenceCountersTable {
  tenant_id: string;
  last_reference: number;
}

/** An assembly or disassembly order (0039). */
export interface ErpAssemblyOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number>;
  direction: Generated<AssemblyDirection>;
  item_id: string;
  bom_id: string;
  location_id: string;
  quantity: string;
  status: Generated<AssemblyOrderStatus>;
  planned_for: string | Date | null;
  plan_id: string | null;
  note: string | null;
  unit_cost: string | null;
  labour_cost: string | null;
  overhead_cost: string | null;
  created_by: string;
  created_at: CreatedAt;
  completed_by: string | null;
  completed_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  version: Generated<number>;
  updated_at: UpdatedAt;
}

/** A planning run (0039). */
export interface ErpMrpPlansTable {
  id: Generated<string>;
  tenant_id: string;
  horizon_end: string | Date;
  run_by: string;
  run_at: Generated<Date>;
}

export interface ErpMrpSuggestionsTable {
  id: Generated<string>;
  tenant_id: string;
  plan_id: string;
  item_id: string;
  action: 'build' | 'buy';
  level: number;
  required: string;
  available: string;
  on_order: string;
  reorder_minimum: string;
  quantity: string;
  need_by: string | Date;
  order_by: string | Date;
  lead_time_days: number;
  supplier_id: string | null;
  bom_id: string | null;
  basis: string;
  drafted_kind: 'assembly_order' | 'purchase_order' | null;
  drafted_id: string | null;
  drafted_at: Date | null;
}

export interface CustomerContactsTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  is_primary: Generated<boolean>;
  notes: string | null;
  archived_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SitesTable extends Omit<AddressColumns, 'address_line1'> {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  name: string;
  address_line1: string;
  latitude: Coordinate;
  longitude: Coordinate;
  geocode_status: Generated<GeocodeStatus>;
  geocode_accuracy: string | null;
  geocoded_at: Date | null;
  contact_id: string | null;
  access_gate_code: string | null;
  access_parking: string | null;
  access_ask_for: string | null;
  access_hazards: string | null;
  access_notes: string | null;
  /** Set by trigger whenever an access note changes. */
  access_updated_at: ColumnType<Date | null, never, never>;
  access_updated_by: string | null;
  archived_at: Date | null;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  search: ColumnType<string, never, never>;
  /** Sample data loaded at onboarding (0018), removable in one action. */
  is_demo: Generated<boolean>;
}

export interface ChecklistTemplateItem {
  id: string;
  label: string;
}

export interface JobTypesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  code: string;
  description: string | null;
  expected_duration_minutes: number | null;
  default_priority: Generated<WorkOrderPriority>;
  instructions: string | null;
  checklist: Jsonb<ChecklistTemplateItem[]>;
  /** Photos to take before and after the work; copied to each new job (0013). */
  before_photos: Generated<number>;
  after_photos: Generated<number>;
  signature_required: Generated<boolean>;
  archived_at: Date | null;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface JobTypeFormsTable {
  tenant_id: string;
  job_type_id: string;
  form_id: string;
  required: Generated<boolean>;
  position: Generated<number>;
  created_at: CreatedAt;
}

/** Written only by assign_work_order_reference. */
export interface WorkOrderCountersTable {
  tenant_id: ColumnType<string, never, never>;
  last_reference: ColumnType<number, never, never>;
}

export interface WorkOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  /** Assigned by trigger. */
  reference: ColumnType<number, never, never>;
  customer_id: string;
  site_id: string;
  job_type_id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  priority: Generated<WorkOrderPriority>;
  state: Generated<WorkOrderState>;
  due_from: Date | null;
  due_by: Date | null;
  /** Maintained by trigger. */
  state_changed_at: ColumnType<Date, never, never>;
  completed_at: ColumnType<Date | null, never, never>;
  reviewed_at: ColumnType<Date | null, never, never>;
  cancelled_at: ColumnType<Date | null, never, never>;
  last_actor: string;
  last_reason: string | null;
  /** Incremented by trigger on every update. */
  revision: ColumnType<number, never, never>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  search: ColumnType<string, never, never>;
  before_photos: Generated<number>;
  after_photos: Generated<number>;
  signature_required: Generated<boolean>;
  /** The customer's sign-off, or why nobody could sign (0013). */
  signed_off_at: Date | null;
  signed_off_by: string | null;
  signoff_file_id: string | null;
  signoff_name: string | null;
  signoff_role: string | null;
  signoff_unavailable_reason: string | null;
  /** Sample data loaded at onboarding (0018), removable in one action. */
  is_demo: Generated<boolean>;
}

export interface WorkOrderFormsTable {
  tenant_id: string;
  work_order_id: string;
  form_id: string;
  required: Generated<boolean>;
  position: Generated<number>;
  added_by: string;
  created_at: CreatedAt;
}

export interface WorkOrderChecklistItemsTable {
  id: Generated<string>;
  tenant_id: string;
  work_order_id: string;
  position: number;
  label: string;
  done: Generated<boolean>;
  done_by: string | null;
  done_at: Date | null;
  created_at: CreatedAt;
}

export interface WorkOrderAssignmentsTable {
  id: Generated<string>;
  tenant_id: string;
  work_order_id: string;
  user_id: string;
  is_lead: Generated<boolean>;
  assigned_by: string;
  assigned_at: CreatedAt;
  unassigned_at: Date | null;
  unassigned_by: string | null;
}

export interface WorkOrderCommentsTable {
  id: Generated<string>;
  tenant_id: string;
  work_order_id: string;
  author_id: string;
  visibility: CommentVisibility;
  body: string;
  created_at: CreatedAt;
}

/** Written only by trigger; the runtime role may read it. */
export interface WorkOrderEventsTable {
  id: ColumnType<string, never, never>;
  sequence: ColumnType<string, never, never>;
  tenant_id: ColumnType<string, never, never>;
  work_order_id: ColumnType<string, never, never>;
  kind: ColumnType<WorkOrderEventKind, never, never>;
  from_state: ColumnType<WorkOrderState | null, never, never>;
  to_state: ColumnType<WorkOrderState | null, never, never>;
  user_id: ColumnType<string | null, never, never>;
  actor_id: ColumnType<string, never, never>;
  reason: ColumnType<string | null, never, never>;
  details: ColumnType<Record<string, unknown>, never, never>;
  /** When it happened: for a change made offline, when the phone recorded it. */
  occurred_at: ColumnType<Date, never, never>;
  /** When the server wrote it. */
  recorded_at: ColumnType<Date, never, never>;
}

export interface AttachmentsTable {
  id: Generated<string>;
  tenant_id: string;
  file_id: string;
  customer_id: string | null;
  site_id: string | null;
  work_order_id: string | null;
  /** The asset it belongs to (0031). */
  asset_id: Generated<string | null>;
  /** The expense claim it is a receipt for (0037). */
  expense_claim_id: Generated<string | null>;
  /** The item it shows or documents (0040). */
  item_id: Generated<string | null>;
  /** The merchant purchase it is a receipt for (0040). */
  work_order_purchase_id: Generated<string | null>;
  /** The item's main image (0040). */
  is_main: Generated<boolean>;
  title: string;
  kind: Generated<AttachmentKind>;
  /** For a job photo: taken before or after the work (0013). */
  stage: PhotoStage | null;
  added_by: string;
  created_at: CreatedAt;
  removed_at: Date | null;
  removed_by: string | null;
}

/** Where a device was: captured, or why not. The shape of a submit location (0012). */
export type DeviceLocation =
  | {
      status: 'captured';
      latitude: string;
      longitude: string;
      accuracyMeters?: string | undefined;
      capturedAt: string;
    }
  | { status: 'denied' | 'unavailable' };

/** An engineer's working day (0013). */
export interface ShiftsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  started_at: Date;
  ended_at: Date | null;
  start_location: ColumnType<
    DeviceLocation | null,
    DeviceLocation | null | undefined,
    DeviceLocation | null
  >;
  end_location: ColumnType<
    DeviceLocation | null,
    DeviceLocation | null | undefined,
    DeviceLocation | null
  >;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Where to send a person push notifications (0013). */
export interface PushDevicesTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  session_id: string;
  token: string;
  platform: PushPlatform;
  device_label: string | null;
  created_at: CreatedAt;
  last_registered_at: Generated<Date>;
  disabled_at: Date | null;
  disabled_reason: PushDisabledReason | null;
}

export interface SavedViewsTable {
  id: Generated<string>;
  tenant_id: string;
  owner_id: string;
  resource: 'work_orders';
  name: string;
  filters: Jsonb<Record<string, unknown>>;
  shared: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ImportRowError {
  row: number;
  column: string | null;
  code: string;
  message: string;
}

export interface ImportsTable {
  id: Generated<string>;
  tenant_id: string;
  kind: ImportKind;
  status: Generated<ImportStatus>;
  file_name: string;
  source: string;
  total_rows: Generated<number>;
  succeeded_rows: Generated<number>;
  failed_rows: Generated<number>;
  errors: Jsonb<ImportRowError[]>;
  created_by: string;
  created_at: CreatedAt;
  started_at: Date | null;
  completed_at: Date | null;
}

export const SYNC_ENTITY_KINDS = ['work_order', 'customer', 'site', 'form'] as const;
export type SyncEntityKind = (typeof SYNC_ENTITY_KINDS)[number];

/** A record a transaction changed, by that transaction's id (P12). Written by trigger. */
export interface SyncTouchesTable {
  tenant_id: string;
  entity_kind: SyncEntityKind;
  entity_id: string;
  /** A transaction id (`xid8`), which the driver returns as a decimal string. */
  xid: Generated<string>;
  created_at: CreatedAt;
}

export interface SyncLogMarksTable {
  tenant_id: string;
  pruned_before: string;
}

export const SYNC_TRIGGERS = [
  'launch',
  'foreground',
  'reconnect',
  'background',
  'manual',
  'change',
] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];
export const SYNC_OUTCOMES = ['complete', 'partial', 'offline', 'failed'] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

export interface SyncReportsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  report_id: string;
  started_at: Date;
  duration_ms: number;
  trigger: SyncTrigger;
  outcome: SyncOutcome;
  pushed: Generated<number>;
  conflicts: Generated<number>;
  rejected: Generated<number>;
  retried: Generated<number>;
  pulled: Generated<number>;
  uploads_completed: Generated<number>;
  uploads_failed: Generated<number>;
  uploaded_bytes: ColumnType<string, number | undefined, number>;
  queue_depth: Generated<number>;
  pending_uploads: Generated<number>;
  network_type: string | null;
  clock_offset_ms: number | null;
  app_version: string | null;
  received_at: CreatedAt;
}

/**
 * A signed-in browser for a super admin (0015). Short-lived: this session can
 * reach every company.
 */
export interface PlatformSessionsTable {
  id: Generated<string>;
  platform_user_id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: CreatedAt;
  last_seen_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: PlatformSessionRevocationReason | null;
}

export interface PlatformRefreshTokensTable {
  id: Generated<string>;
  session_id: string;
  token_hash: string;
  created_at: CreatedAt;
  expires_at: Date;
  used_at: Date | null;
  replaced_by: string | null;
}

/** Every super-admin action, append-only and tenant-less (0015). */
export interface PlatformAuditLogTable {
  id: Generated<string>;
  occurred_at: Generated<Date>;
  platform_user_id: string | null;
  actor_label: string;
  action: string;
  /** The company acted on, by id and slug, without a foreign key: this outlives it. */
  tenant_id: string | null;
  tenant_slug: string | null;
  target_kind: string | null;
  target_id: string | null;
  reason: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Generated<Jsonb<Record<string, unknown>>>;
}

export interface FeatureFlagsTable {
  key: string;
  description: string;
  default_enabled: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface TenantFeatureFlagsTable {
  tenant_id: string;
  key: string;
  enabled: boolean;
  updated_at: UpdatedAt;
  updated_by: string | null;
}

export interface AnnouncementsTable {
  id: Generated<string>;
  /** Null means every company. */
  tenant_id: string | null;
  severity: Generated<AnnouncementSeverity>;
  message: Jsonb<Record<string, string>>;
  starts_at: Generated<Date>;
  ends_at: Date | null;
  dismissible: Generated<boolean>;
  created_by: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface TenantExportsTable {
  id: Generated<string>;
  tenant_id: string;
  tenant_slug: string;
  requested_by: string | null;
  status: Generated<TenantExportStatus>;
  object_key: string | null;
  byte_size: string | null;
  contents: Generated<Jsonb<Record<string, number>>>;
  error: string | null;
  created_at: CreatedAt;
  completed_at: Date | null;
  expires_at: Date | null;
}

export interface TenantDeletionsTable {
  id: Generated<string>;
  tenant_id: string;
  tenant_slug: string;
  export_id: string;
  requested_by: string | null;
  reason: string;
  purge_after: Date;
  created_at: CreatedAt;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  completed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Inventory and the field follow-ups (0040; ADR-0012)
// ---------------------------------------------------------------------------

export interface ErpSupplierPricesTable {
  id: Generated<string>;
  tenant_id: string;
  supplier_id: string;
  item_id: string;
  currency_code: string;
  /** `numeric(20,4)`, read as a string. */
  min_quantity: Generated<string>;
  unit_price: string;
  /** Calendar dates, read as `YYYY-MM-DD` text. */
  valid_from: ColumnType<string, string, string>;
  valid_to: ColumnType<string | null, string | null, string | null>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpSalesDeliveriesTable {
  id: Generated<string>;
  tenant_id: string;
  reference: Generated<number>;
  order_id: string;
  location_id: string;
  notes: string | null;
  delivered_by: string;
  delivered_at: CreatedAt;
}

export interface ErpSalesDeliveryLinesTable {
  id: Generated<string>;
  tenant_id: string;
  delivery_id: string;
  order_line_id: string;
  quantity: string;
  unit_cost: string | null;
}

export type VanRequestStatus = 'open' | 'picked' | 'cancelled';

export interface ErpVanRequestsTable {
  id: Generated<string>;
  tenant_id: string;
  van_location_id: string;
  status: Generated<VanRequestStatus>;
  notes: string | null;
  requested_by: string;
  from_location_id: string | null;
  picked_by: string | null;
  picked_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ErpVanRequestLinesTable {
  tenant_id: string;
  request_id: string;
  item_id: string;
  quantity_requested: string;
  quantity_picked: string | null;
}

export interface ErpWorkOrderPurchasesTable {
  id: string;
  tenant_id: string;
  work_order_id: string;
  item_id: string | null;
  description: string;
  merchant: string | null;
  quantity: string;
  unit_price: string;
  note: string | null;
  recorded_by: string;
  occurred_at: Generated<Date>;
  recorded_at: CreatedAt;
  cancelled_by: string | null;
  cancelled_at: Date | null;
}

// ---------------------------------------------------------------------------
// The AI assistant (0044; docs/ai, ADR-0001)
// ---------------------------------------------------------------------------

export type AiLevel = 'off' | 'help' | 'insights' | 'agent';
export type AiQuotaMode = 'daily' | 'monthly' | 'daily_and_monthly';
export type AiPolicyMode = 'inherit' | 'custom';
/** Where a policy's answers come from (0047; ADR-0002 D9). */
export type AiAnswerSource = 'model' | 'library';
export type AiUsageSubjectType = 'tenant' | 'user';
export type AiPeriodType = 'day' | 'month';
export type AiReservationState = 'reserved' | 'completed' | 'released' | 'expired' | 'uncertain';
export type AiMessageRole = 'user' | 'assistant' | 'tool_summary';
export type AiCallPurpose = 'help' | 'insights' | 'agent' | 'other';
export type AiCallStatus = 'success' | 'failed' | 'timeout' | 'unknown';
export type AiProposalState =
  'pending' | 'confirmed' | 'executing' | 'completed' | 'rejected' | 'expired' | 'failed';
export type AiHelpArticleStatus = 'published' | 'disabled';

/** The policy columns a plan and a company override share. Money is USD micros. */
interface AiPolicyColumns {
  level: Generated<AiLevel>;
  answer_source: Generated<AiAnswerSource>;
  quota_mode: AiQuotaMode | null;
  daily_limit: number | null;
  monthly_limit: number | null;
  per_user_daily_limit: number | null;
  per_user_monthly_limit: number | null;
  unlimited_messages: Generated<boolean>;
  monthly_cost_cap_microusd: BigIntColumn | null;
  /** Pooled input-plus-output tokens per UTC day and month; null is no token limit (ADR-0002). */
  daily_token_limit: BigIntColumn | null;
  monthly_token_limit: BigIntColumn | null;
  max_input_tokens: Generated<number>;
  max_output_tokens: Generated<number>;
  max_tool_steps: Generated<number>;
  max_provider_calls: Generated<number>;
  allow_history: Generated<boolean>;
  retention_days: Generated<number>;
  version: Generated<number>;
  updated_at: Generated<Date>;
  /** A platform user's id, kept as a plain value (no foreign key). */
  updated_by: string | null;
}

/** What each plan allows, off until an admin decides. Platform-only. */
export interface AiPlanPoliciesTable extends AiPolicyColumns {
  plan: TenantPlan;
}

/** A company's override, written only by the platform. */
export interface AiTenantPoliciesTable extends AiPolicyColumns {
  tenant_id: string;
  mode: Generated<AiPolicyMode>;
  /** Whether the company's own records may go to the provider for L2 and L3. */
  company_data_to_provider: Generated<boolean>;
  reason: string | null;
}

export interface AiUsagePeriodsTable {
  id: Generated<string>;
  tenant_id: string;
  subject_type: AiUsageSubjectType;
  subject_id: string;
  period_type: AiPeriodType;
  /** `YYYY-MM-DD`, the first UTC day of the period; read as a Date by the driver. */
  period_start_utc: ColumnType<string | Date, string, string>;
  used_messages: Generated<number>;
  reserved_messages: Generated<number>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface AiConversationsTable {
  id: Generated<string>;
  tenant_id: string;
  created_by_user_id: string;
  title: string | null;
  locale: Generated<string>;
  level_at_creation: AiLevel;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface AiMessageReservationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  client_request_id: string;
  request_fingerprint: string;
  /** `YYYY-MM-DD`; read as a Date by the driver, so normalise before comparing. */
  period_day: ColumnType<string | Date, string, string>;
  period_month: ColumnType<string | Date, string, string>;
  state: Generated<AiReservationState>;
  reserved_message_units: Generated<number>;
  reserved_cost_microusd: GeneratedBigInt;
  settled_cost_microusd: BigIntColumn | null;
  provider_attempts: Generated<number>;
  last_error_code: string | null;
  response_message_id: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  settled_at: Date | null;
  /** Tokens held for the call in flight, and used by the request so far (ADR-0002 D5). */
  reserved_tokens: GeneratedBigInt;
  used_tokens: GeneratedBigInt;
}

export interface AiMessagesTable {
  id: Generated<string>;
  tenant_id: string;
  conversation_id: string;
  user_id: string | null;
  role: AiMessageRole;
  content: string;
  /** JSON arrays, written as text so the driver does not read them as Postgres arrays. */
  source_refs: ColumnType<unknown[], string | undefined, string>;
  tool_summaries: ColumnType<unknown[], string | undefined, string>;
  action_proposal_id: string | null;
  usage_reservation_id: string | null;
  redacted: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface AiProviderCallsTable {
  id: Generated<string>;
  tenant_id: string;
  reservation_id: string;
  provider: string;
  model: string;
  attempt_number: Generated<number>;
  purpose: AiCallPurpose;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  tokens_estimated: Generated<boolean>;
  cost_microusd: GeneratedBigInt;
  price_version: string;
  status: AiCallStatus;
  error_code: string | null;
  started_at: Date;
  ended_at: Date | null;
}

export interface AiCostPeriodsTable {
  tenant_id: string;
  period_start_utc: ColumnType<string | Date, string, string>;
  reserved_microusd: GeneratedBigInt;
  spent_microusd: GeneratedBigInt;
  unknown_microusd: GeneratedBigInt;
  updated_at: Generated<Date>;
}

/** A member's percentage of the company's allowance, and their dollar cap (ADR-0002 D6, D7). */
export interface AiMemberLimitsTable {
  tenant_id: string;
  user_id: string;
  /** 1–100, or null: no share and so no assistant. */
  share_percent: number | null;
  /** Set by the platform admin only. */
  monthly_cost_cap_microusd: BigIntColumn | null;
  version: Generated<number>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

/** Tokens used and held per company or member, per UTC day and month (ADR-0002 D5). */
export interface AiTokenPeriodsTable {
  id: Generated<string>;
  tenant_id: string;
  subject_type: AiUsageSubjectType;
  subject_id: string;
  period_type: AiPeriodType;
  period_start_utc: ColumnType<string | Date, string, string>;
  used_tokens: GeneratedBigInt;
  reserved_tokens: GeneratedBigInt;
  updated_at: Generated<Date>;
}

/** One member's share of the company's provider spend per UTC month (ADR-0002 D7). */
export interface AiMemberCostPeriodsTable {
  tenant_id: string;
  user_id: string;
  period_start_utc: ColumnType<string | Date, string, string>;
  reserved_microusd: GeneratedBigInt;
  spent_microusd: GeneratedBigInt;
  unknown_microusd: GeneratedBigInt;
  updated_at: Generated<Date>;
}

/** The deployment's own monthly budget. Platform-only. */
export interface AiPlatformCostPeriodsTable {
  period_start_utc: ColumnType<string | Date, string, string>;
  reserved_microusd: GeneratedBigInt;
  spent_microusd: GeneratedBigInt;
  unknown_microusd: GeneratedBigInt;
  updated_at: Generated<Date>;
}

export interface AiActionProposalsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  tool_key: string;
  typed_payload: Jsonb<Record<string, unknown>>;
  payload_schema_version: Generated<number>;
  display_summary: Jsonb<Record<string, unknown>>;
  request_digest: string;
  resource_versions: Jsonb<Record<string, unknown>>;
  state: Generated<AiProposalState>;
  expires_at: Date;
  confirmed_at: Date | null;
  result_resource_type: string | null;
  result_resource_id: string | null;
  result_summary: Jsonb<Record<string, unknown>> | null;
  execution_idempotency_key: string | null;
  error_code: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AiActionEventsTable {
  id: Generated<string>;
  tenant_id: string;
  proposal_id: string;
  actor_user_id: string | null;
  action: string;
  code: string | null;
  request_id: string | null;
  details: Jsonb<Record<string, unknown>>;
  created_at: Generated<Date>;
}

/** The curated help the assistant cites, in both languages. Platform-only. */
export interface AiHelpArticlesTable {
  article_key: string;
  locale: string;
  module: string;
  title: string;
  summary: string;
  body: string;
  keywords: Generated<string[]>;
  app_route: string | null;
  help_url: string | null;
  feature: string | null;
  min_permission: string | null;
  source_commit: string | null;
  content_hash: string;
  status: Generated<AiHelpArticleStatus>;
  published_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ---------------------------------------------------------------------------
// PDF documents (0048; docs/documents/ADR-0001)
// ---------------------------------------------------------------------------

export type DocumentStatus = 'pending' | 'ready' | 'failed';
export type DocumentLookupRole = 'key' | 'confirm';

export interface DocumentTemplatesTable {
  id: string;
  tenant_id: string;
  form_id: string;
  name: string;
  /** Validated by @integr8/document-render before it is written. */
  design: Jsonb<unknown>;
  design_schema_version: Generated<number>;
  revision: Generated<number>;
  archived_at: Date | null;
  created_by: string;
  updated_by: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface DocumentsTable {
  id: string;
  tenant_id: string;
  template_id: string;
  template_revision: number;
  submission_id: string;
  form_id: string;
  title: string;
  /** The QR link's key (D7). */
  public_code: string;
  status: Generated<DocumentStatus>;
  failure_code: string | null;
  file_id: string | null;
  byte_size: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  page_count: number | null;
  sha256: string | null;
  rendered_at: Date | null;
  expired_at: Date | null;
  expired_by: string | null;
  expires_at: Date | null;
  created_by: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface DocumentFieldValuesTable {
  tenant_id: string;
  document_id: string;
  field_key: string;
  /** The field's label, per language, when the document was made. */
  label: Jsonb<Record<string, string>>;
  value: string;
  value_normalized: string;
  lookup_role: DocumentLookupRole | null;
}

/** Platform-level: issued by staff managers; the runtime role reaches nothing here. */
export interface WebsiteKeysTable {
  id: string;
  tenant_id: string;
  key_hash: string;
  key_hint: string;
  label: string | null;
  enabled: Generated<boolean>;
  created_by: string;
  created_at: CreatedAt;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
  lookups: ColumnType<string, never, string | number>;
  found: ColumnType<string, never, string | number>;
}

// ---------------------------------------------------------------------------
// Egyptian e-invoicing (migration 0049; ADR-0014)
// ---------------------------------------------------------------------------

export interface EtaSettingsTable {
  tenant_id: string;
  enabled: Generated<boolean>;
  environment: Generated<EtaEnvironment>;
  issuer_type: Generated<string>;
  taxpayer_id: string | null;
  issuer_name: string | null;
  branch_id: string | null;
  activity_code: string | null;
  address_country: string | null;
  address_governate: string | null;
  address_region_city: string | null;
  address_street: string | null;
  address_building_number: string | null;
  address_postal_code: string | null;
  address_floor: string | null;
  address_room: string | null;
  address_landmark: string | null;
  address_additional: string | null;
  client_id_sealed: string | null;
  client_secret_sealed: string | null;
  credentials_hint: string | null;
  credentials_version: Generated<number>;
  credentials_updated_at: Date | null;
  credentials_updated_by: string | null;
  intermediary_for: string | null;
  document_type_version: Generated<string>;
  default_item_type: EtaItemType | null;
  default_item_code: string | null;
  pinned_certificates: Generated<string[]>;
  version: Generated<number>;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface EtaAddressColumns {
  address_country: string | null;
  address_governate: string | null;
  address_region_city: string | null;
  address_street: string | null;
  address_building_number: string | null;
  address_postal_code: string | null;
  address_floor: string | null;
  address_room: string | null;
  address_landmark: string | null;
  address_additional: string | null;
}

export interface EtaReceiversTable extends EtaAddressColumns {
  tenant_id: string;
  customer_id: string;
  receiver_type: EtaReceiverType;
  receiver_id: string | null;
  updated_by: string;
  updated_at: Generated<Date>;
}

export interface EtaItemCodesTable {
  tenant_id: string;
  item_id: string;
  item_type: EtaItemType;
  item_code: string;
  updated_by: string;
  updated_at: Generated<Date>;
}

export interface EtaUnitTypesTable {
  tenant_id: string;
  unit: string;
  eta_unit_type: string;
  updated_by: string;
  updated_at: Generated<Date>;
}

export interface EtaTaxMappingsTable {
  tenant_id: string;
  tax_rate_bp: number;
  tax_type: string;
  sub_type: string;
  updated_by: string;
  updated_at: Generated<Date>;
}

export interface EtaDocumentsTable {
  id: string;
  tenant_id: string;
  document_kind: Generated<EtaDocumentKind>;
  invoice_id: string;
  sequence: number;
  environment: EtaEnvironment;
  internal_id: string;
  state: Generated<EtaDocumentState>;
  unsigned_json: string;
  canonical_sha256: string;
  signed_json: string | null;
  signer_certificate: string | null;
  signed_by: string | null;
  signed_at: Date | null;
  exchange_rate: string | null;
  total_amount: string;
  currency_code: string;
  eta_uuid: string | null;
  eta_long_id: string | null;
  submission_id: string | null;
  eta_status: string | null;
  errors: Jsonb<unknown[]>;
  last_error_code: string | null;
  prepared_by: string;
  prepared_at: CreatedAt;
  submitted_by: string | null;
  submitted_at: Date | null;
  final_at: Date | null;
  next_check_at: Date | null;
  checks: Generated<number>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface EtaAttemptsTable {
  id: Generated<string>;
  tenant_id: string;
  document_id: string | null;
  kind: EtaAttemptKind;
  outcome: EtaAttemptOutcome;
  http_status: number | null;
  error_code: string | null;
  message: string | null;
  correlation_id: string | null;
  started_at: Generated<Date>;
  finished_at: Generated<Date>;
  actor_id: string | null;
}

export interface EtaSigningRequestsTable {
  id: string;
  tenant_id: string;
  document_id: string;
  digest: string;
  nonce: string;
  status: Generated<EtaSigningStatus>;
  requested_by: string;
  requested_at: Generated<Date>;
  expires_at: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  finished_at: Date | null;
  failure: string | null;
}

export interface EtaSchemasTable {
  tenant_id: string;
  environment: EtaEnvironment;
  document_type: string;
  type_version: string;
  eta_type_id: string;
  eta_version_id: string;
  schema_text: string;
  schema_sha256: string;
  fetched_by: string;
  fetched_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  platform_users: PlatformUsersTable;
  platform_sessions: PlatformSessionsTable;
  platform_refresh_tokens: PlatformRefreshTokensTable;
  platform_audit_log: PlatformAuditLogTable;
  feature_flags: FeatureFlagsTable;
  tenant_feature_flags: TenantFeatureFlagsTable;
  announcements: AnnouncementsTable;
  tenant_exports: TenantExportsTable;
  tenant_deletions: TenantDeletionsTable;
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
  submission_events: SubmissionEventsTable;
  submission_values: SubmissionValuesTable;
  tenant_storage: TenantStorageTable;
  upload_intents: UploadIntentsTable;
  files: FilesTable;
  tenant_storage_usage: TenantStorageUsageTable;
  plan_allowances: PlanAllowancesTable;
  ai_plan_policies: AiPlanPoliciesTable;
  ai_platform_cost_periods: AiPlatformCostPeriodsTable;
  ai_help_articles: AiHelpArticlesTable;
  tenant_storage_samples: TenantStorageSamplesTable;
  storage_reconciliations: StorageReconciliationsTable;
  scheduled_task_runs: ScheduledTaskRunsTable;
  subscriptions: SubscriptionsTable;
  billing_events: BillingEventsTable;
  customers: CustomersTable;
  crm_leads: CrmLeadsTable;
  crm_pipelines: CrmPipelinesTable;
  crm_pipeline_stages: CrmPipelineStagesTable;
  crm_opportunities: CrmOpportunitiesTable;
  crm_opportunity_events: CrmOpportunityEventsTable;
  crm_opportunity_amounts: CrmOpportunityAmountsTable;
  crm_activities: CrmActivitiesTable;
  crm_activity_leads: CrmActivityLeadsTable;
  crm_activity_customers: CrmActivityCustomersTable;
  crm_activity_opportunities: CrmActivityOpportunitiesTable;
  erp_item_categories: ErpItemCategoriesTable;
  erp_items: ErpItemsTable;
  erp_stock_locations: ErpStockLocationsTable;
  erp_stock_counts: ErpStockCountsTable;
  erp_stock_count_lines: ErpStockCountLinesTable;
  erp_stock_movements: ErpStockMovementsTable;
  erp_stock_balances: ErpStockBalancesTable;
  erp_reorder_levels: ErpReorderLevelsTable;
  erp_suppliers: ErpSuppliersTable;
  erp_purchase_order_counters: ErpPurchaseOrderCountersTable;
  erp_purchase_orders: ErpPurchaseOrdersTable;
  erp_purchase_order_lines: ErpPurchaseOrderLinesTable;
  erp_goods_receipts: ErpGoodsReceiptsTable;
  erp_goods_receipt_lines: ErpGoodsReceiptLinesTable;
  erp_work_order_materials: ErpWorkOrderMaterialsTable;
  sales_document_counters: SalesDocumentCountersTable;
  crm_quotes: CrmQuotesTable;
  crm_quote_lines: CrmQuoteLinesTable;
  erp_sales_orders: ErpSalesOrdersTable;
  erp_sales_order_lines: ErpSalesOrderLinesTable;
  erp_sales_order_work_orders: ErpSalesOrderWorkOrdersTable;
  erp_finance_settings: ErpFinanceSettingsTable;
  finance_document_counters: FinanceDocumentCountersTable;
  erp_invoices: ErpInvoicesTable;
  erp_invoice_lines: ErpInvoiceLinesTable;
  erp_credit_notes: ErpCreditNotesTable;
  erp_credit_note_lines: ErpCreditNoteLinesTable;
  erp_payment_receipts: ErpPaymentReceiptsTable;
  erp_payment_allocations: ErpPaymentAllocationsTable;
  erp_asset_settings: ErpAssetSettingsTable;
  asset_reference_counters: AssetReferenceCountersTable;
  erp_assets: ErpAssetsTable;
  document_templates: DocumentTemplatesTable;
  documents: DocumentsTable;
  document_field_values: DocumentFieldValuesTable;
  website_keys: WebsiteKeysTable;
  eta_settings: EtaSettingsTable;
  eta_receivers: EtaReceiversTable;
  eta_item_codes: EtaItemCodesTable;
  eta_unit_types: EtaUnitTypesTable;
  eta_tax_mappings: EtaTaxMappingsTable;
  eta_documents: EtaDocumentsTable;
  eta_attempts: EtaAttemptsTable;
  eta_signing_requests: EtaSigningRequestsTable;
  eta_schemas: EtaSchemasTable;
  erp_asset_events: ErpAssetEventsTable;
  erp_work_order_assets: ErpWorkOrderAssetsTable;
  erp_ledger_accounts: ErpLedgerAccountsTable;
  erp_ledger_settings: ErpLedgerSettingsTable;
  erp_ledger_periods: ErpLedgerPeriodsTable;
  erp_ledger_period_events: ErpLedgerPeriodEventsTable;
  journal_reference_counters: JournalReferenceCountersTable;
  erp_journals: ErpJournalsTable;
  erp_journal_lines: ErpJournalLinesTable;
  erp_ledger_year_closes: ErpLedgerYearClosesTable;
  erp_ledger_postings: ErpLedgerPostingsTable;
  member_grants: MemberGrantsTable;
  tenant_roles: TenantRolesTable;
  hr_employees: HrEmployeesTable;
  hr_expense_categories: HrExpenseCategoriesTable;
  expense_reference_counters: ExpenseReferenceCountersTable;
  hr_expense_claims: HrExpenseClaimsTable;
  hr_payroll_rule_sets: HrPayrollRuleSetsTable;
  hr_pay_terms: HrPayTermsTable;
  hr_payroll_runs: HrPayrollRunsTable;
  hr_payroll_lines: HrPayrollLinesTable;
  erp_boms: ErpBomsTable;
  erp_bom_components: ErpBomComponentsTable;
  assembly_reference_counters: AssemblyReferenceCountersTable;
  erp_assembly_orders: ErpAssemblyOrdersTable;
  erp_mrp_plans: ErpMrpPlansTable;
  erp_mrp_suggestions: ErpMrpSuggestionsTable;
  erp_supplier_prices: ErpSupplierPricesTable;
  erp_stock_lots: ErpStockLotsTable;
  erp_stock_lot_balances: ErpStockLotBalancesTable;
  erp_sales_deliveries: ErpSalesDeliveriesTable;
  erp_sales_delivery_lines: ErpSalesDeliveryLinesTable;
  erp_van_requests: ErpVanRequestsTable;
  erp_van_request_lines: ErpVanRequestLinesTable;
  erp_work_order_purchases: ErpWorkOrderPurchasesTable;
  customer_contacts: CustomerContactsTable;
  sites: SitesTable;
  job_types: JobTypesTable;
  job_type_forms: JobTypeFormsTable;
  work_order_counters: WorkOrderCountersTable;
  work_orders: WorkOrdersTable;
  work_order_forms: WorkOrderFormsTable;
  work_order_checklist_items: WorkOrderChecklistItemsTable;
  work_order_assignments: WorkOrderAssignmentsTable;
  work_order_comments: WorkOrderCommentsTable;
  work_order_events: WorkOrderEventsTable;
  attachments: AttachmentsTable;
  saved_views: SavedViewsTable;
  imports: ImportsTable;
  sync_touches: SyncTouchesTable;
  sync_log_marks: SyncLogMarksTable;
  sync_reports: SyncReportsTable;
  shifts: ShiftsTable;
  push_devices: PushDevicesTable;
  form_templates: FormTemplatesTable;
  rate_limit_buckets: RateLimitBucketsTable;
  schema_migrations: SchemaMigrationsTable;
  signup_requests: SignupRequestsTable;
  signup_events: SignupEventsTable;
  tenant_settings: TenantSettingsTable;
  ai_tenant_policies: AiTenantPoliciesTable;
  ai_usage_periods: AiUsagePeriodsTable;
  ai_conversations: AiConversationsTable;
  ai_message_reservations: AiMessageReservationsTable;
  ai_messages: AiMessagesTable;
  ai_provider_calls: AiProviderCallsTable;
  ai_cost_periods: AiCostPeriodsTable;
  ai_action_proposals: AiActionProposalsTable;
  ai_action_events: AiActionEventsTable;
  ai_member_limits: AiMemberLimitsTable;
  ai_token_periods: AiTokenPeriodsTable;
  ai_member_cost_periods: AiMemberCostPeriodsTable;
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
  // Running the business (0015). A super admin's identity, sessions and record
  // of what they did belong to no company, and the runtime role reaches none of
  // them. `announcements` carries a nullable tenant_id because a null is every
  // company; the API reads it as the platform and hands each company its own.
  // `tenant_exports` and `tenant_deletions` name a company without a foreign key,
  // because the record that one was exported and purged outlives it.
  'platform_sessions',
  'platform_refresh_tokens',
  'platform_audit_log',
  'announcements',
  'tenant_exports',
  'tenant_deletions',
  // The flags that exist belong to no company; every company reads them and its
  // own answers beside them.
  'feature_flags',
  // Metering (0016). What a plan is allowed belongs to the plan, not to any one
  // company on it; and the record of when a recurring task last ran belongs to
  // the platform that runs it.
  'plan_allowances',
  'scheduled_task_runs',
  // What the billing provider told us, and when (0017). Its tenant_id is
  // nullable — an event can name a customer this deployment does not know —
  // so it cannot be isolated the usual way, and the runtime role holds nothing
  // on it at all.
  'billing_events',
  // Self-serve signup (0018). Both describe people who are not yet customers:
  // a signup request exists before any company does, and the funnel's whole
  // purpose is to record the attempts that never became one. `audit_log`
  // cannot hold either, being tenant-scoped. The runtime role reaches neither.
  'signup_requests',
  'signup_events',
  // The assistant (0044; ADR-0001). What a plan allows belongs to the plan; the
  // help it cites belongs to the product; the deployment's own provider budget
  // belongs to nobody's company. The runtime role reaches none of them.
  'ai_plan_policies',
  'ai_platform_cost_periods',
  'ai_help_articles',
  // A company website's key for the document lookup (0048; documents
  // ADR-0001 D11). Issued and revoked by staff managers, looked up before any
  // company is known, and never reached by the runtime role. It names its
  // company with a foreign key, so the purge removes it with the company.
  'website_keys',
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
export const SECURITY_DEFINER_FUNCTIONS = [
  'reject_platform_user_membership',
  // Deletes every row of one company, in an order it works out itself, with the
  // audit log's no-delete trigger off for the length of the purge; see 0015.
  'purge_tenant',
  // Writes submission history and reportable values, which the runtime role
  // cannot write itself; see 0008.
  'record_submission_change',
  // Keeps the storage usage rollup, which the runtime role can only read; see 0009.
  'record_file_usage',
  // Hands out work order references from a counter the runtime role cannot write; see 0010.
  'assign_work_order_reference',
  // Write work order history, which the runtime role can only read; see 0010.
  'record_work_order_change',
  'record_work_order_assignment',
  // Write and prune the sync change log, which the runtime role can only read; see 0011.
  'touch_sync',
  'prune_sync_touches',
  // Applies each stock movement to its balance, which the runtime role can
  // only read; see 0026 and ADR-0003.
  'erp_stock_apply_movement',
  // Locks a balance row for the caller's own company, which the runtime role
  // can only read; see 0026.
  'erp_stock_lock_balance',
  // The same for each serial number's or batch's balance; see 0042 and ADR-0013.
  'erp_stock_apply_lot_movement',
  'erp_stock_lock_lot_balance',
  // Keeps each opportunity's amounts, which the runtime role can only read; see 0043.
  'crm_opportunity_record_amount',
  // Hands out purchase order references from a counter the runtime role cannot write; see 0027.
  'assign_purchase_order_reference',
  'assign_sales_reference',
  // Numbers invoices, credit notes and payments from a counter the runtime role
  // cannot write; locks a payment receipt and an invoice while an allocation is
  // decided, which the runtime role may not do itself; see 0030.
  'assign_finance_reference',
  'erp_payment_allocations_guard',
  // Numbers assets from a counter the runtime role cannot write; see 0031.
  'assign_asset_reference',
  // Numbers journals when posted from a counter the runtime role cannot write; see 0033.
  'assign_journal_reference',
  // Capture documents into the ledger's queue, which the runtime role cannot
  // insert into, and post them; see 0034.
  'erp_ledger_capture',
  'erp_ledger_try_post',
  'erp_ledger_backfill',
  'assign_expense_reference',
  'assign_assembly_reference',
  'erp_ledger_backfill_more',
] as const;
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
  tenant_feature_flags: true,
  tenant_storage_samples: true,
  storage_reconciliations: true,
  subscriptions: true,
  tenant_settings: true,
  ai_tenant_policies: true,
  ai_usage_periods: true,
  ai_conversations: true,
  ai_message_reservations: true,
  ai_messages: true,
  ai_provider_calls: true,
  ai_cost_periods: true,
  ai_action_proposals: true,
  ai_action_events: true,
  ai_member_limits: true,
  ai_token_periods: true,
  ai_member_cost_periods: true,
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
  submission_events: true,
  submission_values: true,
  tenant_storage: true,
  upload_intents: true,
  files: true,
  tenant_storage_usage: true,
  customers: true,
  crm_leads: true,
  crm_pipelines: true,
  crm_pipeline_stages: true,
  crm_opportunities: true,
  crm_opportunity_events: true,
  crm_opportunity_amounts: true,
  crm_activities: true,
  crm_activity_leads: true,
  crm_activity_customers: true,
  crm_activity_opportunities: true,
  erp_item_categories: true,
  erp_items: true,
  erp_stock_locations: true,
  erp_stock_counts: true,
  erp_stock_count_lines: true,
  erp_stock_movements: true,
  erp_stock_balances: true,
  erp_reorder_levels: true,
  erp_suppliers: true,
  erp_purchase_order_counters: true,
  erp_purchase_orders: true,
  erp_purchase_order_lines: true,
  erp_goods_receipts: true,
  erp_goods_receipt_lines: true,
  erp_work_order_materials: true,
  sales_document_counters: true,
  crm_quotes: true,
  crm_quote_lines: true,
  erp_sales_orders: true,
  erp_sales_order_lines: true,
  erp_sales_order_work_orders: true,
  erp_finance_settings: true,
  finance_document_counters: true,
  erp_invoices: true,
  erp_invoice_lines: true,
  erp_credit_notes: true,
  erp_credit_note_lines: true,
  erp_payment_receipts: true,
  erp_payment_allocations: true,
  erp_asset_settings: true,
  asset_reference_counters: true,
  erp_assets: true,
  document_templates: true,
  documents: true,
  document_field_values: true,
  eta_settings: true,
  eta_receivers: true,
  eta_item_codes: true,
  eta_unit_types: true,
  eta_tax_mappings: true,
  eta_documents: true,
  eta_attempts: true,
  eta_signing_requests: true,
  eta_schemas: true,
  erp_asset_events: true,
  erp_work_order_assets: true,
  erp_ledger_accounts: true,
  erp_ledger_settings: true,
  erp_ledger_periods: true,
  erp_ledger_period_events: true,
  journal_reference_counters: true,
  erp_journals: true,
  erp_journal_lines: true,
  erp_ledger_year_closes: true,
  erp_ledger_postings: true,
  member_grants: true,
  tenant_roles: true,
  hr_employees: true,
  hr_expense_categories: true,
  expense_reference_counters: true,
  hr_expense_claims: true,
  hr_payroll_rule_sets: true,
  hr_pay_terms: true,
  hr_payroll_runs: true,
  hr_payroll_lines: true,
  erp_boms: true,
  erp_bom_components: true,
  assembly_reference_counters: true,
  erp_assembly_orders: true,
  erp_mrp_plans: true,
  erp_mrp_suggestions: true,
  erp_supplier_prices: true,
  erp_stock_lots: true,
  erp_stock_lot_balances: true,
  erp_sales_deliveries: true,
  erp_sales_delivery_lines: true,
  erp_van_requests: true,
  erp_van_request_lines: true,
  erp_work_order_purchases: true,
  customer_contacts: true,
  sites: true,
  job_types: true,
  job_type_forms: true,
  work_order_counters: true,
  work_orders: true,
  work_order_forms: true,
  work_order_checklist_items: true,
  work_order_assignments: true,
  work_order_comments: true,
  work_order_events: true,
  attachments: true,
  saved_views: true,
  imports: true,
  sync_touches: true,
  sync_log_marks: true,
  sync_reports: true,
  shifts: true,
  push_devices: true,
};

export const TENANT_SCOPED_TABLES: readonly TenantScopedTable[] = Object.freeze(
  Object.keys(TENANT_SCOPED) as TenantScopedTable[],
);
