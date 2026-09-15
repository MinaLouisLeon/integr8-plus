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
  AuthRoleTooBroadError,
  closeDatabase,
  configureDatabase,
  getAuthDataSource,
  getPlatformDataSource,
  getTenantDataSource,
  RlsNotEnforcedError,
  withTenant,
  type AuthDataSource,
  type PlatformDataSource,
  type PlatformJobQueue,
  type TenantDataSource,
  type TenantTransaction,
} from './connection.js';

export {
  databaseConfigSchema,
  loadDatabaseConfig,
  requireAdminConnectionString,
  requireAuthConnectionString,
  type DatabaseConfig,
} from './config.js';

export { MissingTenantScopeError } from './tenant-guard.js';

export { assertSchemaUpToDate, SchemaOutOfDateError } from './migrator/status.js';

export {
  CLIENT_APPS,
  clientAppSchema,
  IMPERSONATION_END_REASONS,
  impersonationEndReasonSchema,
  LOGIN_OUTCOMES,
  loginOutcomeSchema,
  OFFLINE_GRANT_REVOCATION_REASONS,
  offlineGrantRevocationReasonSchema,
  SECURITY_DEFINER_FUNCTIONS,
  SECURITY_DEFINER_VIEWS,
  SESSION_REVOCATION_REASONS,
  sessionRevocationReasonSchema,
  type ClientApp,
  type ImpersonationEndReason,
  type LoginOutcome,
  type OfflineGrantRevocationReason,
  type SecurityDefinerFunction,
  type SecurityDefinerView,
  type SessionRevocationReason,
} from './schema.js';

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

export type {
  CreateSessionInput,
  ListSessionsOptions,
  RefreshTokenRecord,
  Session,
  SessionsRepository,
} from './repositories/sessions.js';

export type {
  CreateInvitationInput,
  Invitation,
  InvitationsRepository,
} from './repositories/invitations.js';

export type {
  CreateImpersonationGrantInput,
  ImpersonationGrant,
  ImpersonationRepository,
} from './repositories/impersonation.js';

export type {
  CreateOfflineGrantInput,
  OfflineGrant,
  OfflineGrantsRepository,
} from './repositories/offline-grants.js';

export {
  isLocked,
  type AccountLock,
  type LockPolicy,
  type LoginAttemptInput,
  type LoginSecurityRepository,
} from './repositories/login-security.js';

export {
  isUsableMembership,
  type AuthMembership,
  type AuthMembershipsRepository,
} from './repositories/auth-memberships.js';

export {
  type ClaimIdempotencyKeyInput,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type IdempotencyRepository,
} from './repositories/idempotency.js';

export {
  type ClaimedJob,
  type EnqueueJobInput,
  type FailJobOptions,
  type Job,
  type JobsRepository,
} from './repositories/jobs.js';

export {
  floorToWindow,
  type RateLimitDecision,
  type RateLimitOptions,
  type RateLimitRepository,
} from './repositories/rate-limits.js';

export type {
  CreateDraftInput,
  CreateFormInput,
  Form,
  FormsRepository,
  FormVersion,
  FormVersionSummary,
  PublishOptions,
  SaveDraftResult,
  UpdateFormInput,
} from './repositories/forms.js';

export type {
  FormTemplateInput,
  FormTemplateRecord,
  FormTemplatesReader,
  FormTemplatesWriter,
} from './repositories/form-templates.js';

export type {
  CreateSubmissionInput,
  StartDraftInput,
  Submission,
  SubmissionEvent,
  SubmissionPage,
  SubmissionQuery,
  SubmissionsRepository,
  ValueFilter,
  ValueOperator,
  WriteRefusal,
  WriteResult,
} from './repositories/submissions.js';

export type {
  ConfirmedFile,
  CreateUploadIntentInput,
  FileRecord,
  FilesRepository,
  StorageUsage,
  UploadIntent,
} from './repositories/files.js';

export type { StorageRegistry, TenantBucket } from './repositories/storage-registry.js';

export {
  normaliseTags,
  prefixQuery,
  type Address,
  type ContactInput,
  type Customer,
  type CustomerContact,
  type CustomerInput,
  type CustomerPage,
  type CustomerQuery,
  type CustomersRepository,
} from './repositories/customers.js';

export {
  addressLine,
  type AccessNotes,
  type GeocodeResult,
  type Site,
  type SiteInput,
  type SiteLocation,
  type SiteQuery,
  type SitesRepository,
} from './repositories/sites.js';

export {
  normaliseJobTypeCode,
  type JobType,
  type JobTypeForm,
  type JobTypeInput,
  type JobTypesRepository,
} from './repositories/job-types.js';

export {
  parseWorkOrderReference,
  type Assignment,
  type ChecklistItem,
  type CreateWorkOrderInput,
  type CrewMember,
  type Signoff,
  type SignoffInput,
  type TransitionRefusal,
  type WorkOrder,
  type WorkOrderChanges,
  type WorkOrderComment,
  type WorkOrderEvent,
  type WorkOrderForm,
  type WorkOrderOrder,
  type WorkOrderPage,
  type WorkOrderQuery,
  type WorkOrdersRepository,
  type WorkOrderWrite,
} from './repositories/work-orders.js';

export type {
  Attachment,
  AttachmentOwner,
  AttachmentsRepository,
} from './repositories/attachments.js';

export type {
  SavedView,
  SavedViewInput,
  SavedViewsRepository,
} from './repositories/saved-views.js';

export {
  MAX_RECORDED_IMPORT_ERRORS,
  type ImportRecord,
  type ImportsRepository,
} from './repositories/imports.js';
export { SyncRepository, type SyncPageQuery, type SyncReportInput } from './repositories/sync.js';
export {
  type ClockInResult,
  type ClockOutResult,
  type Shift,
  ShiftsRepository,
} from './repositories/shifts.js';
export { type PushDevice, PushDevicesRepository } from './repositories/push-devices.js';

export {
  ATTACHMENT_KINDS,
  COMMENT_VISIBILITIES,
  CUSTOMER_STATUSES,
  customerStatusSchema,
  GEOCODE_STATUSES,
  IMPORT_KINDS,
  SYNC_ENTITY_KINDS,
  SYNC_OUTCOMES,
  SYNC_TRIGGERS,
  type SyncEntityKind,
  type SyncOutcome,
  type SyncTrigger,
  IMPORT_STATUSES,
  WORK_ORDER_EVENT_KINDS,
  PHOTO_STAGES,
  PUSH_PLATFORMS,
  PUSH_DISABLED_REASONS,
  type DeviceLocation,
  type PhotoStage,
  type PushDisabledReason,
  type PushPlatform,
  type AttachmentKind,
  type ChecklistTemplateItem,
  type CommentVisibility,
  type CustomerStatus,
  type GeocodeStatus,
  type ImportKind,
  type ImportRowError,
  type ImportStatus,
  type WorkOrderEventKind,
} from './schema.js';

export {
  FORM_TEMPLATE_CATEGORIES,
  FORM_VERSION_STATUSES,
  formVersionStatusSchema,
  MEDIA_CATEGORIES,
  STORAGE_PROVIDERS,
  THUMBNAIL_STATUSES,
  USAGE_CATEGORIES,
  REPORTABLE_VALUE_TYPES,
  SUBMISSION_EVENT_KINDS,
  SUBMISSION_STATUSES,
  type FormTemplateCategory,
  type FormVersionStatus,
  type MediaCategory,
  type StorageProvider,
  type ThumbnailStatus,
  type UsageCategory,
  type ReportableFieldSpec,
  type ReportableValueType,
  type SubmissionEventKind,
  type SubmitLocation,
  type SubmissionStatus,
} from './schema.js';

export {
  IDEMPOTENCY_STATUSES,
  idempotencyStatusSchema,
  JOB_STATUSES,
  jobStatusSchema,
  type IdempotencyStatus,
  type JobStatus,
} from './schema.js';
