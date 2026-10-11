import type { Integr8Client, paths } from '@integr8/api-client';
import { createContext, useContext } from 'react';

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
  navigate: (to: string) => void;
  paths: {
    /**
     * The app's home. When set, every list screen offers a way back to it;
     * when not, the app's own shell owns that navigation.
     */
    dashboard?: string;
    workOrders: string;
    newWorkOrder: (options?: { customerId?: string }) => string;
    workOrder: (id: string) => string;
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
    inventory: string;
    items: string;
    item: (id: string) => string;
    stockLocations: string;
    stockLocation: (id: string) => string;
    stockCount: (id: string) => string;
    /** Purchasing (CRM/ERP plan, phase E2). */
    suppliers: string;
    supplier: (id: string) => string;
    purchaseOrders: string;
    purchaseOrder: (id: string) => string;
    /** Sales (CRM/ERP plan, phase S1). */
    quotes: string;
    quote: (id: string) => string;
    salesOrders: string;
    salesOrder: (id: string) => string;
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
    | 'quote'
    | 'salesOrder';
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
export type SavedView = Json<'/v1/saved-views', 'get', 200>['items'][number];
export type ImportRecord = Json<'/v1/imports', 'get', 200>['items'][number];
export type ImportDetail = Json<'/v1/imports/{importId}', 'get', 200>;
export type Me = Json<'/v1/me', 'get', 200>;
export type Member = Json<'/v1/members', 'get', 200>['items'][number];
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
export type Supplier = Json<'/v1/purchasing/suppliers', 'get', 200>['items'][number];
export type SupplierDetail = Json<'/v1/purchasing/suppliers/{supplierId}', 'get', 200>;
export type SupplierStatus = Supplier['status'];
export type PurchaseOrderRow = Json<'/v1/purchasing/orders', 'get', 200>['items'][number];
export type PurchaseOrderStatus = PurchaseOrderRow['status'];
export type PurchaseOrderDetail = Json<'/v1/purchasing/orders/{orderId}', 'get', 200>;
export type PurchaseOrderLine = PurchaseOrderDetail['lines'][number];
export type GoodsReceipt = PurchaseOrderDetail['receipts'][number];
export type QuoteRow = Json<'/v1/sales/quotes', 'get', 200>['items'][number];
export type QuoteStatus = QuoteRow['status'];
export type QuoteDetail = Json<'/v1/sales/quotes/{quoteId}', 'get', 200>;
export type DocumentLine = QuoteDetail['lines'][number];
export type SalesOrderRow = Json<'/v1/sales/orders', 'get', 200>['items'][number];
export type SalesOrderStatus = SalesOrderRow['status'];
export type SalesOrderDetail = Json<'/v1/sales/orders/{orderId}', 'get', 200>;
export type SalesOrderLine = SalesOrderDetail['lines'][number];
export type ToOrderLine = Json<'/v1/sales/to-order', 'get', 200>['items'][number];

export const keys = {
  me: ['me'] as const,
  members: ['members'] as const,
  leads: (query: object) => ['crm', 'leads', query] as const,
  lead: (id: string) => ['crm', 'lead', id] as const,
  leadMatches: (id: string) => ['crm', 'lead', id, 'matches'] as const,
  customerCrm: (id: string) => ['crm', 'customer', id] as const,
  pipelines: ['crm', 'pipelines'] as const,
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
  suppliers: (query: object) => ['purchasing', 'suppliers', query] as const,
  supplier: (id: string) => ['purchasing', 'supplier', id] as const,
  purchaseOrders: (query: object) => ['purchasing', 'orders', query] as const,
  purchaseOrder: (id: string) => ['purchasing', 'order', id] as const,
  quotes: (query: object) => ['sales', 'quotes', query] as const,
  quote: (id: string) => ['sales', 'quote', id] as const,
  salesOrders: (query: object) => ['sales', 'orders', query] as const,
  salesOrder: (id: string) => ['sales', 'order', id] as const,
  toOrder: ['sales', 'to-order'] as const,
  forms: ['forms'] as const,
  jobTypes: (archived: boolean) => ['job-types', archived] as const,
  workOrders: (query: Record<string, unknown>) => ['work-orders', 'list', query] as const,
  workOrder: (id: string) => ['work-orders', id] as const,
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
