import type { Integr8Client, paths } from '@integr8/api-client';
import { createContext, useContext } from 'react';
import type { VoiceInput } from './ai/voice.js';

/**
 * What the operational screens need from the app that hosts them.
 *
 * The same idea as `@integr8/form-renderer-dom/screens`: the web and desktop
 * apps authenticate and route differently, and everything else about customers,
 * sites and work orders is the same, so that is all they supply.
 */
export interface OperationsConfig {
  client: Integr8Client;
  locale: string;
  /** `replace` swaps the current entry, for a page that only forwards (a scanned tag). */
  navigate: (to: string, options?: { replace?: boolean }) => void;
  paths: {
    /**
     * The app's home. When set, every list screen offers a way back to it;
     * when not, the app's own shell owns that navigation.
     */
    dashboard?: string;
    workOrders: string;
    newWorkOrder: (options?: { customerId?: string }) => string;
    workOrder: (id: string) => string;
    /** The scheduling board (P25), where the host app has it (the desktop app). */
    schedule?: string;
    customers: string;
    customer: (id: string) => string;
    site: (id: string) => string;
    jobTypes: string;
    imports: string;
    /** A submission, filled in or read back. */
    submission: (id: string) => string;
    /** Submissions filtered to one job. */
    submissionsForWorkOrder: (workOrderId: string) => string;
    /** The CRM's front page, its lead list, and one lead (CRM/ERP plan). */
    crm: string;
    crmLeads: string;
    crmLead: (id: string) => string;
    crmLeadConvert: (id: string) => string;
    crmOpportunities: string;
    crmOpportunity: (id: string) => string;
    crmActivities: string;
    /** Pipelines and their stages, kept by owners and admins (eighth round; ADR-0012). */
    crmPipelines: string;
    crmPipeline: (id: string) => string;
    /** The CRM's figures: quotes, win rates and pipeline value (eighth round). */
    crmReports: string;
    inventory: string;
    /** Parts used on jobs, by engineer, customer or job type (eighth round). */
    partsUsage: string;
    items: string;
    item: (id: string) => string;
    stockLocations: string;
    stockLocation: (id: string) => string;
    stockCount: (id: string) => string;
    /** A location's reorder list, to draft purchase orders from (eighth round; ADR-0012). */
    reorder: (locationId: string) => string;
    /** The store's queue of requests to refill vans (eighth round; ADR-0012). */
    vanRequests: string;
    /** Serial numbers and batches (ninth round; ADR-0013): the lookup, and one traced. */
    lots: string;
    lot: (id: string) => string;
    /** Purchasing (CRM/ERP plan, phase E2). */
    suppliers: string;
    supplier: (id: string) => string;
    purchaseOrders: string;
    purchaseOrder: (id: string) => string;
    /** Manufacturing (seventh round; ADR-0011): bills, assembly orders and planning. */
    boms: string;
    /** An item's bill of materials, by the item. */
    bom: (itemId: string) => string;
    /** One version of a bill, in use or superseded, read-only. */
    bomVersion: (bomId: string) => string;
    assemblyOrders: string;
    assemblyOrder: (id: string) => string;
    materialPlans: string;
    materialPlan: (id: string) => string;
    /** Sales (CRM/ERP plan, phase S1). */
    quotes: string;
    quote: (id: string) => string;
    salesOrders: string;
    salesOrder: (id: string) => string;
    /** A delivery note of an order, to print (eighth round; ADR-0012). */
    deliveryNote: (orderId: string, deliveryId: string) => string;
    /** Finance (CRM/ERP plan, phase B1). */
    invoices: string;
    invoice: (id: string) => string;
    payments: string;
    payment: (id: string) => string;
    financeSettings: string;
    /** Assets (CRM/ERP plan, phase E3). */
    assets: string;
    asset: (id: string) => string;
    /** PDF documents made from submissions (docs/documents). */
    documents: string;
    document: (id: string) => string;
    /** Egyptian e-invoicing (docs/e-invoicing; ADR-0014): the register and one ETA document. */
    eInvoicing: string;
    etaDocument: (id: string) => string;
    /** The signing agent's queue, where the host app has one (the desktop app). */
    etaSigning?: string;
    /** The general ledger (CRM/ERP plan, phase A1; ADR-0009). */
    ledger: string;
    ledgerAccounts: string;
    journals: string;
    journal: (id: string) => string;
    /** A new manual journal, or with `opening` the opening balances. */
    newJournal: (options?: { opening?: boolean }) => string;
    editJournal: (id: string) => string;
    unposted: string;
    unpostedItem: (id: string) => string;
    ledgerPeriods: string;
    ledgerReports: string;
    ledgerSettings: string;
    /** HR: employee profiles (seventh round; ADR-0010). */
    employees: string;
    employee: (id: string) => string;
    newEmployee: string;
    editEmployee: (id: string) => string;
    /** The signed-in person's own employee profile. */
    myProfile: string;
    /** Staff expense claims (seventh round; ADR-0010): one's own, and a new one. */
    myExpenseClaims: string;
    newExpenseClaim: string;
    /** Everybody's claims, for those who approve them. */
    expenseClaims: string;
    expenseClaim: (id: string) => string;
    /** What expenses may be claimed for, kept by those who approve claims. */
    expenseCategories: string;
    /** Egyptian payroll (seventh round; ADR-0010): the runs, one run, the rules, one's payslips. */
    payRuns: string;
    payRun: (id: string) => string;
    payrollRules: string;
    myPayslips: string;
    /** The Integr8 Plus assistant (docs/ai; ADR-0001). */
    assistant: string;
    /**
     * Where the assistant's citations may point when the host app has the
     * page: people, company settings, billing, submissions and forms are the
     * app's own, so each is optional and a citation without one shows no link.
     */
    people?: string;
    companySettings?: string;
    billing?: string;
    submissions?: string;
    forms?: string;
  };
  /** Saves a file the person asked for, such as an import template. */
  download: (blob: Blob, filename: string) => void;
  /**
   * Map tiles for placing a site. `undefined` shows coordinates and the
   * device's location only — where the app's content policy allows no tile host.
   */
  mapTiles?: { url: string; attribution: string; maxZoom?: number };
  /** The browser's IANA time zone, for reading dates in imports. Defaults to the runtime's. */
  timeZone?: string;
  /**
   * The signed-in seat's permissions, when the app already has them. Without
   * it, a screen that needs one reads `/v1/me` itself.
   */
  permissions?: readonly string[];
  /**
   * A row's own menu, such as the desktop app's right-click menu. When set,
   * right-clicking a row calls it with the same actions the row's buttons and
   * links offer, and the browser's menu is not shown. When not set, rows keep
   * the browser's menu.
   */
  rowActions?: RowActionsHandler;
  /**
   * Where a spoken question to the assistant can come from here. The browser's
   * own recognition when not set; the desktop app says the operating system's
   * dictation does it instead, because its web view has no recogniser.
   */
  voiceInput?: VoiceInput;
}

/** What a row is about, for a row menu. */
export interface RowTarget {
  kind:
    | 'workOrder'
    | 'customer'
    | 'site'
    | 'jobType'
    | 'timesheetShift'
    | 'lead'
    | 'opportunity'
    | 'item'
    | 'stockLocation'
    | 'supplier'
    | 'purchaseOrder'
    | 'bom'
    | 'assemblyOrder'
    | 'quote'
    | 'salesOrder'
    | 'invoice'
    | 'payment'
    | 'asset'
    | 'document'
    | 'journal'
    | 'posting'
    | 'employee'
    | 'expenseClaim';
  id: string;
  label: string;
}

/** One entry of a row menu: already translated, and doing what the row's own control does. */
export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** The pointer event that opened a row menu: where, and how to stop the browser's own. */
export interface RowActionsEvent {
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

export type RowActionsHandler = (
  target: RowTarget,
  actions: readonly RowAction[],
  event: RowActionsEvent,
) => void;

export const OperationsContext = createContext<OperationsConfig | undefined>(undefined);

export function useOperations(): OperationsConfig {
  const config = useContext(OperationsContext);
  if (config === undefined) {
    throw new Error('Operational screens need an <OperationsContext.Provider>.');
  }
  return config;
}

type Json<
  P extends keyof paths,
  M extends 'get' | 'post' | 'put' | 'patch',
  S extends number,
> = paths[P][M] extends { responses: Record<S, { content: { 'application/json': infer T } }> }
  ? T
  : never;

export type WorkOrderPage = Json<'/v1/work-orders', 'get', 200>;
export type WorkOrderSummary = WorkOrderPage['items'][number];
export type WorkOrderDetail = Json<'/v1/work-orders/{workOrderId}', 'get', 200>;
export type WorkOrderState = WorkOrderSummary['state'];
export type Priority = WorkOrderSummary['priority'];
export type CustomerPage = Json<'/v1/customers', 'get', 200>;
export type Customer = CustomerPage['items'][number];
export type CustomerDetail = Json<'/v1/customers/{customerId}', 'get', 200>;
export type Site = CustomerDetail['sites'][number];
export type SiteDetail = Json<'/v1/sites/{siteId}', 'get', 200>;
export type JobType = Json<'/v1/job-types', 'get', 200>['items'][number];
/** The scheduling board (P25): a calendar's visits, and the jobs still waiting for one. */
export type Schedule = Json<'/v1/schedule', 'get', 200>;
export type ScheduleVisit = Schedule['visits'][number];
export type SchedulePerson = Schedule['people'][number];
export type ScheduleJob = Schedule['workOrders'][number];
export type UnscheduledJob = Json<'/v1/schedule/unscheduled', 'get', 200>['items'][number];
export type BulkVisitResult = Json<'/v1/visits/bulk', 'post', 200>['results'][number];
export type SavedView = Json<'/v1/saved-views', 'get', 200>['items'][number];
export type ImportRecord = Json<'/v1/imports', 'get', 200>['items'][number];
export type ImportDetail = Json<'/v1/imports/{importId}', 'get', 200>;
export type Me = Json<'/v1/me', 'get', 200>;
export type Member = Json<'/v1/members', 'get', 200>['items'][number];
/** The company's own roles (ADR-0013), and what they are built from. */
export type CompanyRoleList = Json<'/v1/roles', 'get', 200>;
export type CompanyRole = CompanyRoleList['items'][number];
export type RoleCatalogue = Json<'/v1/roles/catalogue', 'get', 200>;
export type Timesheet = Json<'/v1/timesheets', 'get', 200>;
export type LeadPage = Json<'/v1/crm/leads', 'get', 200>;
export type Lead = LeadPage['items'][number];
export type LeadDetail = Json<'/v1/crm/leads/{leadId}', 'get', 200>;
export type LeadStatus = Lead['status'];
export type LeadSource = Lead['source'];
export type LeadMatch = Json<'/v1/crm/leads/{leadId}/matches', 'get', 200>['items'][number];
export type LeadConversion = Json<'/v1/crm/leads/{leadId}/convert', 'post', 201>;
export type CustomerCrm = Json<'/v1/customers/{customerId}/crm', 'get', 200>;
export type Pipeline = Json<'/v1/crm/pipelines', 'get', 200>['items'][number];
export type Stage = Pipeline['stages'][number];
export type PipelineDetail = Json<'/v1/crm/pipelines/{pipelineId}', 'get', 200>;
export type PipelineStage = PipelineDetail['stages'][number];
export type TimelinePage = Json<'/v1/customers/{customerId}/timeline', 'get', 200>;
export type TimelineEntry = TimelinePage['items'][number];
export type TimelineSource = TimelinePage['sources'][number];
export type QuoteFigures = Json<'/v1/analytics/quotes', 'get', 200>['items'][number];
export type PipelineFigures = Json<'/v1/analytics/pipeline', 'get', 200>;
export type StageValues = Json<'/v1/analytics/pipelines/{pipelineId}/stage-values', 'get', 200>;
export type PartsUsage = Json<'/v1/analytics/parts-usage', 'get', 200>;
export type OpportunityPage = Json<'/v1/crm/opportunities', 'get', 200>;
export type Opportunity = OpportunityPage['items'][number];
export type OpportunityDetail = Json<'/v1/crm/opportunities/{opportunityId}', 'get', 200>;
export type ActivityPage = Json<'/v1/crm/activities', 'get', 200>;
export type Activity = ActivityPage['items'][number];
export type ActivityKind = Activity['kind'];
export type CrmDashboard = Json<'/v1/crm/dashboard', 'get', 200>;
export type ItemPage = Json<'/v1/inventory/items', 'get', 200>;
export type ItemRow = ItemPage['items'][number];
export type ItemDetail = Json<'/v1/inventory/items/{itemId}', 'get', 200>;
export type InventoryItem = ItemDetail['item'];
export type ItemKind = InventoryItem['kind'];
export type Unit = InventoryItem['unit'];
export type ItemCategory = Json<'/v1/inventory/categories', 'get', 200>['items'][number];
export type StockLocation = Json<'/v1/inventory/locations', 'get', 200>['items'][number];
export type StockLocationDetail = Json<'/v1/inventory/locations/{locationId}', 'get', 200>;
export type StockMovement = Json<'/v1/inventory/movements', 'get', 200>['items'][number];
export type StockBalance = Json<'/v1/inventory/balances', 'get', 200>['items'][number];
export type StockCountDetail = Json<'/v1/inventory/counts/{countId}', 'get', 200>;
export type StockCountRow = Json<'/v1/inventory/counts', 'get', 200>['items'][number];
/** Serial numbers and batches (ninth round; ADR-0013). */
export type ItemTracking = InventoryItem['tracking'];
export type ItemLot = Json<'/v1/inventory/items/{itemId}/lots', 'get', 200>['items'][number];
export type LotMatch = Json<'/v1/inventory/lots', 'get', 200>['items'][number];
export type LotTrace = Json<'/v1/inventory/lots/{lotId}', 'get', 200>;
export type LotHistoryEntry = LotTrace['history'][number];
export type LotSourceKind = LotHistoryEntry['source']['kind'];
export type Supplier = Json<'/v1/purchasing/suppliers', 'get', 200>['items'][number];
export type SupplierDetail = Json<'/v1/purchasing/suppliers/{supplierId}', 'get', 200>;
export type SupplierStatus = Supplier['status'];
export type PurchaseOrderRow = Json<'/v1/purchasing/orders', 'get', 200>['items'][number];
export type PurchaseOrderStatus = PurchaseOrderRow['status'];
export type PurchaseOrderDetail = Json<'/v1/purchasing/orders/{orderId}', 'get', 200>;
export type PurchaseOrderLine = PurchaseOrderDetail['lines'][number];
export type GoodsReceipt = PurchaseOrderDetail['receipts'][number];
export type BomRow = Json<'/v1/manufacturing/boms', 'get', 200>['items'][number];
export type ItemBom = Json<'/v1/manufacturing/boms/items/{itemId}', 'get', 200>;
export type Bom = NonNullable<ItemBom['current']>;
export type AssemblyOrderRow = Json<'/v1/manufacturing/orders', 'get', 200>['items'][number];
export type AssemblyOrderStatus = AssemblyOrderRow['status'];
export type AssemblyDirection = AssemblyOrderRow['direction'];
export type AssemblyOrderDetail = Json<'/v1/manufacturing/orders/{orderId}', 'get', 200>;
export type MaterialPlanRow = Json<'/v1/manufacturing/plans', 'get', 200>['items'][number];
export type MaterialPlan = Json<'/v1/manufacturing/plans/{planId}', 'get', 200>;
export type PlanSuggestion = MaterialPlan['suggestions'][number];
export type PlanDrafted = Json<'/v1/manufacturing/plans/{planId}/draft', 'post', 200>;
export type QuoteRow = Json<'/v1/sales/quotes', 'get', 200>['items'][number];
export type QuoteStatus = QuoteRow['status'];
export type QuoteDetail = Json<'/v1/sales/quotes/{quoteId}', 'get', 200>;
export type DocumentLine = QuoteDetail['lines'][number];
export type SalesOrderRow = Json<'/v1/sales/orders', 'get', 200>['items'][number];
export type SalesOrderStatus = SalesOrderRow['status'];
export type SalesOrderDetail = Json<'/v1/sales/orders/{orderId}', 'get', 200>;
export type SalesOrderLine = SalesOrderDetail['lines'][number];
export type ToOrderLine = Json<'/v1/sales/to-order', 'get', 200>['items'][number];
export type SalesDelivery = Json<
  '/v1/sales/orders/{orderId}/deliveries',
  'get',
  200
>['items'][number];
export type DeliveryNote = Json<'/v1/sales/deliveries/{deliveryId}', 'get', 200>;
export type ItemMedia = Json<'/v1/inventory/items/{itemId}/media', 'get', 200>['items'][number];
export type SupplierPrice = Json<'/v1/purchasing/prices', 'get', 200>['items'][number];
export type ReorderLine = Json<
  '/v1/inventory/locations/{locationId}/reorder',
  'get',
  200
>['items'][number];
export type ReorderDrafted = Json<'/v1/inventory/locations/{locationId}/reorder', 'post', 201>;
export type VanRequest = Json<'/v1/inventory/van-requests', 'get', 200>['items'][number];
export type VanRequestStatus = VanRequest['status'];
export type JobPurchases = Json<'/v1/work-orders/{workOrderId}/purchases', 'get', 200>;
export type JobPurchase = JobPurchases['items'][number];
export type InvoiceRow = Json<'/v1/finance/invoices', 'get', 200>['items'][number];
export type InvoiceStatus = InvoiceRow['status'];
export type InvoiceDetail = Json<'/v1/finance/invoices/{invoiceId}', 'get', 200>;
export type InvoiceLine = InvoiceDetail['lines'][number];
export type CreditNoteRow = InvoiceDetail['creditNotes'][number];
export type PaymentRow = Json<'/v1/finance/payments', 'get', 200>['items'][number];
export type PaymentMethod = PaymentRow['method'];
export type PaymentDetail = Json<'/v1/finance/payments/{receiptId}', 'get', 200>;
export type CustomerAccount = Json<'/v1/finance/customers/{customerId}/account', 'get', 200>;
export type JobCosts = Json<'/v1/finance/work-orders/{workOrderId}/costs', 'get', 200>;
export type FinanceSettings = Json<'/v1/finance/settings', 'get', 200>;
export type AssetRow = Json<'/v1/assets', 'get', 200>['items'][number];
export type AssetStatus = AssetRow['status'];
export type AssetCondition = NonNullable<AssetRow['condition']>;
export type AssetDetail = Json<'/v1/assets/{assetId}', 'get', 200>;
export type AssetTimelineEntry = Json<
  '/v1/assets/{assetId}/timeline',
  'get',
  200
>['entries'][number];
export type JobAssets = Json<'/v1/work-orders/{workOrderId}/assets', 'get', 200>;
export type AssetSettings = Json<'/v1/assets/settings', 'get', 200>;
export type DocumentRow = Json<'/v1/documents', 'get', 200>['items'][number];
export type DocumentDetail = Json<'/v1/documents/{documentId}', 'get', 200>;
export type DocumentState = 'active' | 'expired' | 'pending' | 'failed';
export type EtaSettings = Json<'/v1/eta/settings', 'get', 200>;
export type EtaAddress = EtaSettings['address'];
export type EtaCodes = Json<'/v1/eta/codes', 'get', 200>;
export type EtaReceiver = EtaCodes['receivers'][number];
export type EtaSchemaSummary = Json<'/v1/eta/schemas', 'get', 200>['items'][number];
export type EtaAvailableType = Json<'/v1/eta/schemas/available', 'get', 200>['items'][number];
export type EtaDocumentPage = Json<'/v1/eta/documents', 'get', 200>;
export type EtaDocument = EtaDocumentPage['items'][number];
export type EtaDocumentState = EtaDocument['state'];
export type EtaDocumentDetail = Json<'/v1/eta/documents/{documentId}', 'get', 200>;
export type EtaInvoicePanel = Json<'/v1/eta/invoices/{invoiceId}', 'get', 200>;
export type EtaReadinessIssue = EtaInvoicePanel['readiness'][number];
export type EtaSigningRequest = Json<'/v1/eta/signing-requests', 'get', 200>['items'][number];
export type EtaClaimed = Json<'/v1/eta/signing-requests/{requestId}/claim', 'post', 200>;
export type LedgerOverview = Json<'/v1/ledger', 'get', 200>;
export type LedgerSettings = NonNullable<LedgerOverview['settings']>;
export type LedgerAccount = Json<'/v1/ledger/accounts', 'get', 200>['items'][number];
export type AccountType = LedgerAccount['type'];
export type PostingRoleKey = NonNullable<LedgerAccount['role']>;
export type JournalPage = Json<'/v1/ledger/journals', 'get', 200>;
export type JournalSummary = JournalPage['items'][number];
export type JournalKindKey = JournalSummary['kind'];
export type JournalDetail = Json<'/v1/ledger/journals/{journalId}', 'get', 200>;
export type OpeningReceivables = Json<'/v1/ledger/opening-receivables', 'get', 200>;
export type LedgerPeriods = Json<'/v1/ledger/periods', 'get', 200>;
export type PostingPage = Json<'/v1/ledger/postings', 'get', 200>;
export type PostingRow = PostingPage['items'][number];
export type PostingSourceKind = PostingRow['source']['kind'];
export type PostingReason = NonNullable<PostingRow['reason']>;
export type PostingStatus = PostingRow['status'];
export type PostingDetail = Json<'/v1/ledger/postings/{postingId}', 'get', 200>;
export type PostAllResult = Json<'/v1/ledger/postings/post-all', 'post', 200>;
export type LedgerYear = Json<'/v1/ledger/years', 'get', 200>['items'][number];
export type TrialBalance = Json<'/v1/ledger/reports/trial-balance', 'get', 200>;
export type AccountActivity = Json<'/v1/ledger/reports/account-activity', 'get', 200>;
export type ReceivablesReport = Json<'/v1/ledger/reports/receivables', 'get', 200>;
export type ProfitAndLoss = Json<'/v1/ledger/reports/profit-and-loss', 'get', 200>;
export type BalanceSheet = Json<'/v1/ledger/reports/balance-sheet', 'get', 200>;
export type EmployeePage = Json<'/v1/hr/employees', 'get', 200>;
export type Employee = Json<'/v1/hr/employees/{employeeId}', 'get', 200>;
export type EmployeeStatus = Employee['status'];
export type EmployeeCreateBody = NonNullable<
  paths['/v1/hr/employees']['post']['requestBody']
>['content']['application/json'];
export type EmployeeUpdateBody = NonNullable<
  paths['/v1/hr/employees/{employeeId}']['patch']['requestBody']
>['content']['application/json'];
export type SealedFieldName = Json<'/v1/hr/employees/{employeeId}/reveal', 'post', 200>['field'];
export type ExpenseClaimPage = Json<'/v1/expenses', 'get', 200>;
export type ExpenseClaimRow = ExpenseClaimPage['items'][number];
export type ExpenseClaimStatus = ExpenseClaimRow['status'];
export type ExpenseClaimDetail = Json<'/v1/expenses/{claimId}', 'get', 200>;
export type ExpenseReceipt = ExpenseClaimDetail['receipts'][number];
export type ExpenseCategory = Json<'/v1/expenses/categories', 'get', 200>['items'][number];
export type PayrollRuleSetList = Json<'/v1/payroll/rule-sets', 'get', 200>;
export type PayrollRuleSet = PayrollRuleSetList['items'][number];
export type PayTerms = Json<'/v1/hr/employees/{employeeId}/pay-terms', 'get', 200>['items'][number];
export type PayRunPage = Json<'/v1/payroll/runs', 'get', 200>;
export type PayRunSummary = PayRunPage['items'][number];
export type PayRunDetail = Json<'/v1/payroll/runs/{runId}', 'get', 200>;
export type PayLine = PayRunDetail['lines'][number];
export type Payslip = Json<'/v1/hr/me/payslips', 'get', 200>['items'][number];
/** The assistant (docs/ai; ADR-0001): what it may do, a conversation, its messages and a prepared action. */
export type AiCapabilities = Json<'/v1/ai/capabilities', 'get', 200>;
export type AiLevel = AiCapabilities['level'];
export type AiBlockedBy = NonNullable<AiCapabilities['blockedBy']>;
export type AiUsage = AiCapabilities['usage'];
/** What is left of an allowance, as a percentage only (ADR-0002 D7). */
export type AiAllowance = AiUsage['allowance'];
export type AiConversation = Json<'/v1/ai/conversations', 'get', 200>['items'][number];
export type AiConversationDetail = Json<'/v1/ai/conversations/{conversationId}', 'get', 200>;
export type AiMessage = AiConversationDetail['messages'][number];
export type AiSource = AiMessage['sources'][number];
export type AiProposal = NonNullable<AiMessage['actionProposal']>;
export type AiProposalState = AiProposal['state'];
export type AiAnswer = Json<'/v1/ai/conversations/{conversationId}/messages', 'post', 200>;

export const keys = {
  me: ['me'] as const,
  members: ['members'] as const,
  roles: (archived: boolean) => ['roles', 'list', archived] as const,
  roleCatalogue: ['roles', 'catalogue'] as const,
  leads: (query: object) => ['crm', 'leads', query] as const,
  lead: (id: string) => ['crm', 'lead', id] as const,
  leadMatches: (id: string) => ['crm', 'lead', id, 'matches'] as const,
  customerCrm: (id: string) => ['crm', 'customer', id] as const,
  pipelines: ['crm', 'pipelines'] as const,
  pipeline: (id: string) => ['crm', 'pipeline', id] as const,
  customerTimeline: (id: string, sources: readonly string[]) =>
    ['customers', id, 'timeline', sources] as const,
  analytics: (report: string, query: object) => ['analytics', report, query] as const,
  opportunities: (query: object) => ['crm', 'opportunities', query] as const,
  opportunity: (id: string) => ['crm', 'opportunity', id] as const,
  activities: (query: object) => ['crm', 'activities', query] as const,
  dashboard: ['crm', 'dashboard'] as const,
  categories: ['inventory', 'categories'] as const,
  items: (query: object) => ['inventory', 'items', query] as const,
  item: (id: string) => ['inventory', 'item', id] as const,
  stockLocations: (query: object) => ['inventory', 'locations', query] as const,
  stockLocation: (id: string) => ['inventory', 'location', id] as const,
  movements: (query: object) => ['inventory', 'movements', query] as const,
  balances: (query: object) => ['inventory', 'balances', query] as const,
  stockCounts: (query: object) => ['inventory', 'counts', query] as const,
  stockCount: (id: string) => ['inventory', 'count', id] as const,
  itemMedia: (itemId: string) => ['inventory', 'item-media', itemId] as const,
  itemLots: (itemId: string, locationId: string) =>
    ['inventory', 'item-lots', itemId, locationId] as const,
  lotSearch: (code: string) => ['inventory', 'lot-search', code] as const,
  lot: (id: string) => ['inventory', 'lot', id] as const,
  reorder: (locationId: string) => ['inventory', 'reorder', locationId] as const,
  vanRequests: (query: object) => ['inventory', 'van-requests', query] as const,
  jobPurchases: (workOrderId: string) => ['inventory', 'job-purchases', workOrderId] as const,
  media: (mediaId: string) => ['media', mediaId] as const,
  suppliers: (query: object) => ['purchasing', 'suppliers', query] as const,
  supplier: (id: string) => ['purchasing', 'supplier', id] as const,
  purchaseOrders: (query: object) => ['purchasing', 'orders', query] as const,
  purchaseOrder: (id: string) => ['purchasing', 'order', id] as const,
  supplierPrices: (query: object) => ['purchasing', 'prices', query] as const,
  boms: (query: object) => ['manufacturing', 'boms', query] as const,
  bom: (itemId: string) => ['manufacturing', 'bom', itemId] as const,
  bomVersion: (bomId: string) => ['manufacturing', 'bom-version', bomId] as const,
  assemblyOrders: (query: object) => ['manufacturing', 'orders', query] as const,
  assemblyOrder: (id: string) => ['manufacturing', 'order', id] as const,
  materialPlans: ['manufacturing', 'plans'] as const,
  materialPlan: (id: string) => ['manufacturing', 'plan', id] as const,
  quotes: (query: object) => ['sales', 'quotes', query] as const,
  quote: (id: string) => ['sales', 'quote', id] as const,
  salesOrders: (query: object) => ['sales', 'orders', query] as const,
  salesOrder: (id: string) => ['sales', 'order', id] as const,
  toOrder: ['sales', 'to-order'] as const,
  deliveries: (orderId: string) => ['sales', 'deliveries', orderId] as const,
  deliveryNote: (id: string) => ['sales', 'delivery', id] as const,
  invoices: (query: object) => ['finance', 'invoices', query] as const,
  invoice: (id: string) => ['finance', 'invoice', id] as const,
  payments: (query: object) => ['finance', 'payments', query] as const,
  payment: (id: string) => ['finance', 'payment', id] as const,
  customerAccount: (id: string) => ['finance', 'customer', id] as const,
  jobCosts: (id: string) => ['finance', 'job', id] as const,
  financeSettings: ['finance', 'settings'] as const,
  assets: (query: object) => ['assets', 'list', query] as const,
  asset: (id: string) => ['assets', 'asset', id] as const,
  assetTimeline: (id: string) => ['assets', 'timeline', id] as const,
  jobAssets: (id: string) => ['assets', 'job', id] as const,
  assetSettings: ['assets', 'settings'] as const,
  documents: (query: object) => ['documents', 'list', query] as const,
  document: (id: string) => ['documents', 'document', id] as const,
  etaSettings: ['eta', 'settings'] as const,
  etaCodes: ['eta', 'codes'] as const,
  etaSchemas: ['eta', 'schemas'] as const,
  etaDocuments: (query: object) => ['eta', 'documents', query] as const,
  etaDocument: (id: string) => ['eta', 'document', id] as const,
  etaInvoice: (invoiceId: string, exchangeRate: string) =>
    ['eta', 'invoice', invoiceId, exchangeRate] as const,
  etaSigningQueue: ['eta', 'signing-queue'] as const,
  ledger: ['ledger', 'overview'] as const,
  ledgerAccounts: (archived: boolean) => ['ledger', 'accounts', archived] as const,
  journals: (query: object) => ['ledger', 'journals', query] as const,
  journal: (id: string) => ['ledger', 'journal', id] as const,
  openingReceivables: ['ledger', 'opening-receivables'] as const,
  ledgerPeriods: (date: string) => ['ledger', 'periods', date] as const,
  ledgerYears: ['ledger', 'years'] as const,
  postings: (query: object) => ['ledger', 'postings', query] as const,
  posting: (id: string) => ['ledger', 'posting', id] as const,
  ledgerReport: (report: string, query: object) => ['ledger', 'report', report, query] as const,
  // HR. A revealed ID or bank number is never put under any key: it lives in
  // the screen that asked for it and goes when the screen does.
  employees: (query: object) => ['hr', 'employees', query] as const,
  employee: (id: string) => ['hr', 'employee', id] as const,
  myProfile: ['hr', 'me'] as const,
  expenseClaims: (query: object) => ['expenses', 'claims', query] as const,
  expenseClaim: (id: string) => ['expenses', 'claim', id] as const,
  expenseCategories: (archived: boolean) => ['expenses', 'categories', archived] as const,
  // Payroll. Payslips are kept under their own keys, apart from the runs.
  payRuns: ['payroll', 'runs'] as const,
  payRun: (id: string) => ['payroll', 'run', id] as const,
  payrollRuleSets: ['payroll', 'rule-sets'] as const,
  payTerms: (employeeId: string) => ['payroll', 'terms', employeeId] as const,
  runPayslips: (id: string) => ['payroll', 'payslips', id] as const,
  myPayslips: ['payroll', 'mine'] as const,
  // The assistant. Capabilities carry the usage meter, so an answer updates
  // them in place rather than asking again.
  aiCapabilities: ['ai', 'capabilities'] as const,
  aiConversations: ['ai', 'conversations'] as const,
  aiConversation: (id: string) => ['ai', 'conversation', id] as const,
  /** The seat's own recent jobs, for saying which job an expense was for. */
  myRecentJobs: ['work-orders', 'mine-recent'] as const,
  forms: ['forms'] as const,
  jobTypes: (archived: boolean) => ['job-types', archived] as const,
  workOrders: (query: Record<string, unknown>) => ['work-orders', 'list', query] as const,
  workOrder: (id: string) => ['work-orders', id] as const,
  // Under work-orders, so a change to a job also refreshes the board.
  schedule: (range: { from: string; to: string; cancelled: boolean }) =>
    ['work-orders', 'schedule', range] as const,
  unscheduled: ['work-orders', 'unscheduled'] as const,
  views: ['saved-views'] as const,
  customers: (query: Record<string, unknown>) => ['customers', 'list', query] as const,
  customer: (id: string) => ['customers', id] as const,
  tags: ['customer-tags'] as const,
  site: (id: string) => ['sites', id] as const,
  imports: ['imports'] as const,
  import: (id: string) => ['imports', id] as const,
  columns: (kind: string) => ['imports', 'columns', kind] as const,
  timesheet: (query: { from: string; to: string; userId: string }) =>
    ['timesheets', query] as const,
};
