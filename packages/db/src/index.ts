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

export { assertSchemaUpToDate, SchemaOutOfDateError, type SchemaCheck } from './migrator/status.js';

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
  SIGN_IN_METHODS,
  signInMethodSchema,
  type SignInMethod,
  type ClientApp,
  type ImpersonationEndReason,
  type LoginOutcome,
  type OfflineGrantRevocationReason,
  type SecurityDefinerFunction,
  type SecurityDefinerView,
  type SessionRevocationReason,
} from './schema.js';

export {
  ANNOUNCEMENT_SEVERITIES,
  PLATFORM_SESSION_REVOCATION_REASONS,
  BILLING_INTERVALS,
  OVERAGE_POLICIES,
  RECONCILIATION_STATUSES,
  SIGNUP_STATUSES,
  type SignupStatus,
  SUBSCRIPTION_STATUSES,
  TENANT_EXPORT_STATUSES,
  TENANT_PLANS,
  BILLING_MODES,
  type BillingMode,
  COMPANY_THEMES,
  companyThemeSchema,
  type CompanyTheme,
  type AnnouncementSeverity,
  type PlatformSessionRevocationReason,
  type BillingInterval,
  type OveragePolicy,
  type ReconciliationStatus,
  type SubscriptionStatus,
  type TenantExportStatus,
  type TenantPlan,
  type AiLevel as DbAiLevel,
  type AiHelpArticleStatus,
} from './schema.js';

export type {
  AppendPlatformAuditInput,
  PlatformAuditEntry,
  PlatformAuditPage,
  PlatformAuditQuery,
  PlatformAuditRepository,
} from './repositories/platform-audit.js';

export type {
  CreatePlatformSessionInput,
  PlatformRefreshLookup,
  PlatformSession,
  PlatformSessionsRepository,
} from './repositories/platform-sessions.js';

export type {
  Announcement,
  CreateAnnouncementInput,
  FeatureFlag,
  FeatureFlagsReader,
  PlatformSettingsRepository,
  UpsertFeatureFlagInput,
} from './repositories/platform-settings.js';

export {
  AiQuotaExceededError,
  AiBudgetExceededError,
  AiMemberBudgetExceededError,
  AiTokenQuotaExceededError,
  type AiTokenLimits,
  micros,
  dayKey,
  type AiMessageReservation,
  type AiUsageCounter,
  type AiPeriodKeys,
  type ReserveAiMessageInput,
  type ReserveAiMessageOutcome,
  type SettleAiMessageInput,
  type RecordAiProviderCallInput,
  type AiProviderCall,
  type AiUsageRepository,
} from './repositories/ai-usage.js';
export type {
  AiConversation,
  AiMessage,
  AppendAiMessageInput,
  AiConversationsRepository,
} from './repositories/ai-conversations.js';
export type {
  AiActionProposal,
  AiActionEvent,
  CreateAiActionProposalInput,
  AiActionsRepository,
} from './repositories/ai-actions.js';
export {
  AiMemberLimitsVersionConflictError,
  AiSharesOverTotalError,
  type AiMemberLimits,
  type AiMemberLimitsRepository,
} from './repositories/ai-member-limits.js';
export {
  AiPolicyVersionConflictError,
  type AiPolicyFields,
  type AiPlanPolicy,
  type AiTenantPolicy,
  type AiHelpArticle,
  type UpsertAiHelpArticleInput,
  type AiTenantUsageRow,
  type AiPlatformRepository,
} from './repositories/ai-platform.js';

export type {
  IdentityDeletionsRepository,
  PendingIdentityDeletion,
} from './repositories/identity-deletions.js';

export type {
  TenantDeletion,
  TenantExport,
  TenantLifecycleRepository,
} from './repositories/tenant-lifecycle.js';

export type {
  PlatformHealthRepository,
  PlatformInsightsRepository,
  RecentFailure,
  ReleaseInField,
  TimeToFirstSubmission,
} from './repositories/platform-insights.js';

export {
  BillingRepository,
  TenantSubscriptionReader,
  type BillingEvent,
  type Subscription,
} from './repositories/billing.js';
export {
  type FunnelStep,
  type SignupEvent,
  type SignupRequest,
  SignupRepository,
} from './repositories/signup.js';
export { type DemoCounts, DemoDataRepository } from './repositories/demo-data.js';
export {
  DEFAULT_SETTINGS,
  MONEY_RECORD_KINDS,
  type MoneyRecordKind,
  type TenantSettings,
  TenantSettingsRepository,
  TenantSettingsWriter,
} from './repositories/tenant-settings.js';

export {
  StorageMeteringRepository,
  TenantStorageHistory,
  type PlanAllowance,
  type Reconciliation,
  type SampleCategories,
  type StorageSample,
} from './repositories/storage-metering.js';

export type { PlatformCredentials } from './repositories/platform-users.js';

export type { TenantActivityMonth, TenantSummary } from './repositories/tenants.js';

export { EXPORTED_TABLES, type TenantDataExport } from './repositories/tenant-data-export.js';

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
  type CompleteJobOptions,
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
export { DOCUMENT_FILE_ENTITY, TEMPLATE_ASSET_ENTITY } from './repositories/files.js';

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
  type CrmLeadsRepository,
  type Lead,
  type LeadConversionRefusal,
  type LeadCustomerMatch,
  type LeadInput,
  type LeadPage,
  type LeadQuery,
  type LeadUpdateRefusal,
  normaliseEmail,
  phoneDigits,
  trimDecimal,
} from './repositories/crm-leads.js';

export { type Pipeline, type PipelineStage } from './repositories/crm-pipelines.js';
export {
  type Opportunity,
  type OpportunityEvent,
  type OpportunityInput,
  type OpportunityPage,
  type OpportunityQuery,
  type OpportunityRefusal,
} from './repositories/crm-opportunities.js';
export {
  type Activity,
  type ActivityDue,
  type ActivityInput,
  type ActivityLinks,
  type ActivityPage,
  type ActivityQuery,
  type ActivityRefusal,
} from './repositories/crm-activities.js';
export {
  type CrmDashboard,
  type CurrencyTotal,
  type StageSummary,
} from './repositories/crm-reports.js';
export {
  type Item,
  type ItemCategory,
  type ItemInput,
  type ItemPage,
  type ItemQuery,
  type ItemRefusal,
  type ItemWithStock,
} from './repositories/inventory-catalogue.js';
export {
  type Balance,
  type Discrepancy,
  DuplicatePostingError,
  InsufficientStockError,
  type LocationInput,
  type Movement,
  type MovementInput,
  type MovementPage,
  type MovementQuery,
  NotStockItemError,
  LotMismatchError,
  SerialInStockError,
  type StockCount,
  type StockCountLine,
  type StockLocation,
  type StockRefusal,
} from './repositories/inventory-stock.js';
export {
  type GoodsReceipt,
  type GoodsReceiptLine,
  InventoryPurchasingRepository,
  parsePurchaseOrderReference,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderLine,
  type PurchaseOrderLineInput,
  type PurchaseOrderPage,
  type PurchaseOrderQuery,
  type PurchaseOrderTotals,
  type PurchaseRefusal,
  type Supplier,
  type SupplierInput,
  type SupplierQuery,
} from './repositories/inventory-purchasing.js';
export {
  InventoryMaterialsRepository,
  type Material,
  type MaterialInput,
  type MaterialPatch,
} from './repositories/inventory-materials.js';
export {
  addDecimals,
  type DocumentTotals,
  type Quote,
  type QuoteInput,
  type QuoteLine,
  type QuoteLineInput,
  type QuotePage,
  type QuoteQuery,
  type QuoteRefusal,
  type QuoteSnapshot,
  PublicQuotesLookup,
  SalesQuotesRepository,
} from './repositories/sales-quotes.js';
export {
  type DocumentFieldValue,
  type DocumentListQuery,
  type DocumentRecord,
  type DocumentTemplate,
  type WebsiteKey,
  DocumentsRepository,
  DocumentTemplatesRepository,
  linkOpens,
  MAX_LIVE_WEBSITE_KEYS,
  normalizeFieldValue,
  PublicDocumentsLookup,
  WebsiteKeysRepository,
} from './repositories/documents.js';
export {
  HOUSEKEEPING_BATCH_SIZE,
  HOUSEKEEPING_MAX_BATCHES,
  type HousekeepingCutoffs,
  type HousekeepingReport,
  HousekeepingRepository,
} from './repositories/housekeeping.js';
export {
  DEFAULT_ETA_SETTINGS,
  EMPTY_ETA_ADDRESS,
  type EtaAddress,
  type EtaAttempt,
  type EtaDocumentPatch,
  type EtaDocumentRecord,
  type EtaItemCode,
  type EtaReceiver,
  EtaRepository,
  type EtaSchemaRecord,
  type EtaSettings,
  type EtaSettingsInput,
  type EtaSigningRequest,
  type EtaTaxMapping,
} from './repositories/e-invoicing.js';
export {
  type OrderWorkOrderLink,
  type Reservation,
  type SalesOrder,
  type SalesOrderInput,
  type SalesOrderLine,
  type SalesOrderPage,
  type SalesOrderQuery,
  type SalesOrderRefusal,
  SalesOrdersRepository,
  type ShortLine,
} from './repositories/sales-orders.js';
export {
  type CreditNote,
  type CreditNoteIssueRefusal,
  type CreditNoteLine,
  type CreditNoteLineInput,
  DEFAULT_FINANCE_SETTINGS,
  FinanceInvoicesRepository,
  type FinanceSettings,
  type FinanceSettingsInput,
  type Invoice,
  type InvoiceAmounts,
  type InvoiceInput,
  type InvoiceLine,
  type InvoiceLineInput,
  type InvoicePage,
  type InvoiceQuery,
  type InvoiceRefusal,
  type IssuerSnapshot,
} from './repositories/finance-invoices.js';
export {
  type AllocationRefusal,
  type CustomerAccount,
  FinancePaymentsRepository,
  type PaymentAllocation,
  type PaymentReceipt,
  type PaymentReceiptInput,
  type ReceiptAmounts,
} from './repositories/finance-payments.js';
export {
  type Asset,
  type AssetDetailsInput,
  type AssetEvent,
  type AssetLink,
  type AssetListQuery,
  type AssetPart,
  type AssetRegistration,
  type AssetSubmission,
  type AssetWriteContext,
  type AssetWriteRefusal,
  AssetsRepository,
} from './repositories/assets.js';

export {
  LedgerRepository,
  type LedgerAccount,
  type LedgerSettings,
  type PostingAccounts,
  type Journal,
  type JournalLine,
  type JournalLineInput,
  type JournalDraftInput,
  type JournalQuery,
  type PeriodState,
  type PeriodEvent,
  type LedgerPosting,
  type ProposedLine,
} from './repositories/ledger.js';
export {
  LedgerReportsRepository,
  type AccountTotals,
  type ActivityLine,
  type OpenInvoice,
  type YearClose,
} from './repositories/ledger-reports.js';
export { MemberGrantsRepository } from './repositories/member-grants.js';
export {
  HrEmployeesRepository,
  type Employee,
  type EmployeeInput,
  type EmployeeQuery,
  type EmployeeRefusal,
  type SealedField,
} from './repositories/hr-employees.js';
export {
  HrExpensesRepository,
  type ExpenseCategory,
  type ExpenseClaim,
  type ExpenseClaimInput,
  type ExpenseClaimQuery,
} from './repositories/hr-expenses.js';
export {
  HrPayrollRepository,
  emptyTotals as emptyPayRunTotals,
  type PayrollRuleSet,
  type PayTerms,
  type PayTermsInput,
  type PayRun,
  type PayRunTotals,
  type PayLine,
  type PayLineInputs,
  type PayLineResults,
  type PayrollCandidate,
} from './repositories/hr-payroll.js';
export {
  ManufacturingRepository,
  type Bom,
  type BomInput,
  type BomSummary,
  type AssemblyOrder,
  type AssemblyOrderInput,
  type AssemblyOrderQuery,
  type MrpPlan,
  type MrpSuggestion,
  type MrpSuggestionInput,
  type PlanningData,
} from './repositories/manufacturing.js';
export {
  CustomerTimelineRepository,
  TIMELINE_SOURCES,
  type TimelineSource,
  type TimelineKind,
  type TimelineEntry,
} from './repositories/customer-timeline.js';
export {
  AnalyticsRepository,
  type QuoteFigures,
  type PipelineFigures,
  type StageValue,
  type PartsUsage,
  EXPORT_LIMIT,
  type ExportFilter,
  type ExportPage,
  type LeadRow,
  type OpportunityRow,
  type MovementRow,
} from './repositories/analytics.js';
export {
  InventoryLotsRepository,
  type StockLot,
  type LotKind,
  type LotBalance,
  type LotHistoryEntry,
} from './repositories/inventory-lots.js';
export type { MaterialLot } from './schema.js';
export {
  TenantRolesRepository,
  type CompanyRole,
  type TenantRoleInput,
  type TenantRoleRefusal,
} from './repositories/tenant-roles.js';
export {
  SupplierPricesRepository,
  type SupplierPrice,
  type SupplierPriceInput,
} from './repositories/supplier-prices.js';
export {
  InventoryReplenishmentRepository,
  type ReorderNeed,
  type VanRequest,
  type VanRequestLine,
  type VanRequestRefusal,
} from './repositories/inventory-replenishment.js';
export {
  SalesDeliveriesRepository,
  type SalesDelivery,
  type SalesDeliveryLine,
} from './repositories/sales-deliveries.js';
export {
  WorkOrderPurchasesRepository,
  type WorkOrderPurchase,
  type WorkOrderPurchaseInput,
} from './repositories/work-order-purchases.js';

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
export {
  type CreateVisitInput,
  type UnscheduledJob,
  type Visit,
  type VisitChanges,
  type VisitRangeQuery,
  type VisitRefusal,
  type VisitWrite,
  type WorkOrderVisitsRepository,
} from './repositories/work-order-visits.js';
export {
  type ExpiryAlert,
  type MemberQualification,
  type MemberQualificationChanges,
  type MemberQualificationInput,
  type MemberQualificationWrite,
  type QualificationOverride,
  type QualificationOverrideInput,
  type QualificationType,
  type QualificationTypeInput,
  type QualificationTypeWrite,
  type QualificationsRepository,
} from './repositories/qualifications.js';
export {
  type ContractQuery,
  type ContractsRepository,
  type JobCoverage,
  type RenewalAlert,
  type ServiceContract,
  type ServiceContractChanges,
  type ServiceContractInput,
  type ServiceContractWrite,
} from './repositories/contracts.js';
export {
  type DuePlan,
  type JobPlan,
  type LastOccurrence,
  type MaintenancePlan,
  type MaintenancePlanChanges,
  type MaintenancePlanInput,
  type MaintenancePlanWrite,
  type MaintenanceRepository,
  type OccurrenceQuery,
  type OccurrenceRow,
  type PlanQuery,
} from './repositories/maintenance.js';
export {
  type DeadlineNotice,
  type DeadlineReportRow,
  type DeadlinesRepository,
  type JobDeadline,
  type StoredDeadlineRule,
} from './repositories/deadlines.js';

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
export {
  type PushDevice,
  PushDevicesRepository,
  type PushLocale,
} from './repositories/push-devices.js';

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
  type DocumentLookupRole,
  type DocumentStatus,
  type StorageProvider,
  type ThumbnailStatus,
  type UsageCategory,
  type ReportableFieldSpec,
  type ReportableValueType,
  type SubmissionEventKind,
  type SubmitLocation,
  type SubmissionStatus,
  type CarriedOver,
  LEDGER_POSTING_STATUSES,
  type LedgerPostingStatus,
  LEDGER_POSTING_REASONS,
  type LedgerPostingReason,
} from './schema.js';

export {
  IDEMPOTENCY_STATUSES,
  idempotencyStatusSchema,
  JOB_STATUSES,
  jobStatusSchema,
  type IdempotencyStatus,
  type JobStatus,
} from './schema.js';
