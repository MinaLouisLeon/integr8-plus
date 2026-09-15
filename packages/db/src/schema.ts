import { type Role, ROLES, type WorkOrderPriority, type WorkOrderState } from '@integr8/core';
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
  /** Set at publish: which answers are copied into submission_values. Null on versions published before 0008. */
  reportable_fields: Jsonb<ReportableFieldSpec[]> | null;
}

export interface ReportableFieldSpec {
  field: string;
  type: ReportableValueType;
  multiple: boolean;
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
// Customers, sites and work orders (0010)
// ---------------------------------------------------------------------------

export const CUSTOMER_STATUSES = ['active', 'on_hold', 'closed'] as const;
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);
export type CustomerStatus = z.infer<typeof customerStatusSchema>;

export const GEOCODE_STATUSES = ['pending', 'found', 'not_found', 'failed', 'manual'] as const;
export type GeocodeStatus = (typeof GEOCODE_STATUSES)[number];

export const ATTACHMENT_KINDS = ['site_plan', 'manual', 'report', 'photo', 'other'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const COMMENT_VISIBILITIES = ['internal', 'customer'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export const IMPORT_KINDS = ['customers', 'sites', 'work_orders'] as const;
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
  occurred_at: ColumnType<Date, never, never>;
}

export interface AttachmentsTable {
  id: Generated<string>;
  tenant_id: string;
  file_id: string;
  customer_id: string | null;
  site_id: string | null;
  work_order_id: string | null;
  title: string;
  kind: Generated<AttachmentKind>;
  added_by: string;
  created_at: CreatedAt;
  removed_at: Date | null;
  removed_by: string | null;
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
  submission_events: SubmissionEventsTable;
  submission_values: SubmissionValuesTable;
  tenant_storage: TenantStorageTable;
  upload_intents: UploadIntentsTable;
  files: FilesTable;
  tenant_storage_usage: TenantStorageUsageTable;
  customers: CustomersTable;
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
export const SECURITY_DEFINER_FUNCTIONS = [
  'reject_platform_user_membership',
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
};

export const TENANT_SCOPED_TABLES: readonly TenantScopedTable[] = Object.freeze(
  Object.keys(TENANT_SCOPED) as TenantScopedTable[],
);
