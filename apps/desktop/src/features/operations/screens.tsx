import { useTranslation } from '@integr8/i18n';
import {
  CrmOverviewScreen,
  CustomerListScreen,
  CustomerScreen,
  ImportsScreen,
  JobTypesScreen,
  LeadListScreen,
  ActivitiesScreen,
  InventoryOverviewScreen,
  ItemListScreen,
  ItemScreen,
  LocationListScreen,
  LocationScreen,
  OrderListScreen,
  OrderScreen,
  BomListScreen,
  BomScreen,
  AssemblyOrderListScreen,
  AssemblyOrderScreen,
  MaterialPlanListScreen,
  MaterialPlanScreen,
  QuoteListScreen,
  QuoteScreen,
  SalesOrderListScreen,
  SalesOrderScreen,
  DeliveryNoteScreen,
  ReorderScreen,
  VanRequestsScreen,
  FinanceSettingsScreen,
  LedgerHomeScreen,
  LedgerAccountsScreen,
  JournalListScreen,
  JournalEditorScreen,
  JournalScreen,
  UnpostedListScreen,
  UnpostedScreen,
  LedgerPeriodsScreen,
  LedgerReportsScreen,
  LedgerSettingsScreen,
  EmployeeListScreen,
  EmployeeScreen,
  EmployeeEditorScreen,
  MyProfileScreen,
  MyExpenseClaimsScreen,
  NewExpenseClaimScreen,
  ExpenseClaimScreen,
  ExpenseClaimsScreen,
  ExpenseCategoriesScreen,
  PayRunsScreen,
  PayRunScreen,
  PayrollRulesScreen,
  MyPayslipsScreen,
  AssetListScreen,
  WarrantyAlertsPanel,
  AssetScreen,
  InvoiceListScreen,
  InvoiceScreen,
  PaymentListScreen,
  PaymentScreen,
  StockCountScreen,
  SupplierListScreen,
  SupplierScreen,
  LeadConvertScreen,
  OpportunityBoardScreen,
  OpportunityScreen,
  LeadScreen,
  type OperationsConfig,
  OperationsContext,
  SiteScreen,
  TimesheetsScreen,
  WorkOrderFormScreen,
  WorkOrderListScreen,
  WorkOrderScreen,
} from '@integr8/operations-dom';
import { useMemo, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useContextMenu } from '~/components/context-menu';
import { useCustomerChrome, useSiteChrome, useWorkOrderChrome } from '~/components/record-chrome';
import { MAP_TILES } from '~/lib/env';
import { session } from '~/lib/session';

/**
 * Customers, sites, job types, work orders and imports, hosted by the desktop
 * app. The screens are shared with the web app (`@integr8/operations-dom`); the
 * desktop app supplies its keychain-backed session client and hash routes.
 */
function OperationsScreens({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const menu = useContextMenu();
  const config = useMemo<OperationsConfig>(
    () => ({
      client: session().client,
      locale: i18n.language,
      navigate: (to, options) => void navigate(to, { replace: options?.replace === true }),
      paths: {
        workOrders: '/work-orders',
        newWorkOrder: (options) =>
          options?.customerId === undefined
            ? '/work-orders/new'
            : `/work-orders/new?customerId=${options.customerId}`,
        workOrder: (id) => `/work-orders/${id}`,
        customers: '/customers',
        customer: (id) => `/customers/${id}`,
        site: (id) => `/sites/${id}`,
        jobTypes: '/settings/job-types',
        imports: '/imports',
        submission: (id) => `/submissions/${id}`,
        submissionsForWorkOrder: (id) => `/submissions?workOrderId=${id}`,
        crm: '/crm',
        crmLeads: '/crm/leads',
        crmLead: (id) => `/crm/leads/${id}`,
        crmLeadConvert: (id) => `/crm/leads/${id}/convert`,
        crmOpportunities: '/crm/opportunities',
        crmOpportunity: (id) => `/crm/opportunities/${id}`,
        crmActivities: '/crm/activities',
        inventory: '/inventory',
        items: '/inventory/items',
        item: (id) => `/inventory/items/${id}`,
        stockLocations: '/inventory/locations',
        stockLocation: (id) => `/inventory/locations/${id}`,
        stockCount: (id) => `/inventory/counts/${id}`,
        reorder: (locationId) => `/inventory/locations/${locationId}/reorder`,
        vanRequests: '/inventory/van-requests',
        suppliers: '/purchasing/suppliers',
        supplier: (id) => `/purchasing/suppliers/${id}`,
        purchaseOrders: '/purchasing/orders',
        purchaseOrder: (id) => `/purchasing/orders/${id}`,
        boms: '/manufacturing/boms',
        bom: (itemId) => `/manufacturing/boms/${itemId}`,
        assemblyOrders: '/manufacturing/orders',
        assemblyOrder: (id) => `/manufacturing/orders/${id}`,
        materialPlans: '/manufacturing/plans',
        materialPlan: (id) => `/manufacturing/plans/${id}`,
        quotes: '/sales/quotes',
        quote: (id) => `/sales/quotes/${id}`,
        salesOrders: '/sales/orders',
        salesOrder: (id) => `/sales/orders/${id}`,
        deliveryNote: (orderId, deliveryId) => `/sales/orders/${orderId}/deliveries/${deliveryId}`,
        invoices: '/finance/invoices',
        invoice: (id) => `/finance/invoices/${id}`,
        payments: '/finance/payments',
        payment: (id) => `/finance/payments/${id}`,
        financeSettings: '/finance/settings',
        assets: '/assets',
        asset: (id) => `/assets/${id}`,
        ledger: '/ledger',
        ledgerAccounts: '/ledger/accounts',
        journals: '/ledger/journals',
        journal: (id) => `/ledger/journals/${id}`,
        newJournal: (options) =>
          options?.opening === true ? '/ledger/journals/new?kind=opening' : '/ledger/journals/new',
        editJournal: (id) => `/ledger/journals/${id}/edit`,
        unposted: '/ledger/unposted',
        unpostedItem: (id) => `/ledger/unposted/${id}`,
        ledgerPeriods: '/ledger/periods',
        ledgerReports: '/ledger/reports',
        ledgerSettings: '/ledger/settings',
        employees: '/hr/employees',
        employee: (id) => `/hr/employees/${id}`,
        newEmployee: '/hr/employees/new',
        editEmployee: (id) => `/hr/employees/${id}/edit`,
        myProfile: '/hr/me',
        myExpenseClaims: '/hr/expenses',
        newExpenseClaim: '/hr/expenses/new',
        expenseClaims: '/hr/claims',
        expenseClaim: (id) => `/hr/expenses/${id}`,
        expenseCategories: '/hr/claims/categories',
        payRuns: '/hr/pay-runs',
        payRun: (id) => `/hr/pay-runs/${id}`,
        payrollRules: '/hr/payroll-rules',
        myPayslips: '/hr/payslips',
      },
      download: saveFile,
      ...(MAP_TILES === undefined ? {} : { mapTiles: MAP_TILES }),
      // Right-click on a row offers that row's own actions, in the desktop
      // window only; a browser tab keeps its own menu.
      ...(menu.enabled
        ? {
            rowActions: (target, actions, event) => menu.open(event, actions, target.label),
          }
        : {}),
    }),
    [navigate, i18n.language, menu],
  );
  return (
    <OperationsContext.Provider value={config}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">{children}</div>
    </OperationsContext.Provider>
  );
}

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function WorkOrdersRoute() {
  return (
    <OperationsScreens>
      <WorkOrderListScreen />
    </OperationsScreens>
  );
}

export function NewWorkOrderRoute() {
  const [search] = useSearchParams();
  const customerId = search.get('customerId');
  return (
    <OperationsScreens>
      <WorkOrderFormScreen {...(customerId === null ? {} : { customerId })} />
    </OperationsScreens>
  );
}

export function WorkOrderRoute() {
  const { workOrderId = '' } = useParams();
  useWorkOrderChrome(workOrderId);
  return (
    <OperationsScreens>
      <WorkOrderScreen key={workOrderId} workOrderId={workOrderId} />
    </OperationsScreens>
  );
}

/** The CRM's front page (CRM/ERP plan, phase F1). */
export function CrmRoute() {
  return (
    <OperationsScreens>
      <CrmOverviewScreen />
    </OperationsScreens>
  );
}

export function LeadsRoute() {
  return (
    <OperationsScreens>
      <LeadListScreen />
    </OperationsScreens>
  );
}

export function InventoryRoute() {
  return (
    <OperationsScreens>
      <InventoryOverviewScreen />
    </OperationsScreens>
  );
}

export function ItemsRoute() {
  return (
    <OperationsScreens>
      <ItemListScreen />
    </OperationsScreens>
  );
}

export function ItemRoute() {
  const { itemId = '' } = useParams();
  return (
    <OperationsScreens>
      <ItemScreen key={itemId} itemId={itemId} />
    </OperationsScreens>
  );
}

export function StockLocationsRoute() {
  return (
    <OperationsScreens>
      <LocationListScreen />
    </OperationsScreens>
  );
}

export function StockLocationRoute() {
  const { locationId = '' } = useParams();
  return (
    <OperationsScreens>
      <LocationScreen key={locationId} locationId={locationId} />
    </OperationsScreens>
  );
}

/** A location's reorder list, to draft purchase orders from (eighth round; ADR-0012). */
export function ReorderRoute() {
  const { locationId = '' } = useParams();
  return (
    <OperationsScreens>
      <ReorderScreen key={locationId} locationId={locationId} />
    </OperationsScreens>
  );
}

/** The store's queue of van refills (eighth round; ADR-0012). */
export function VanRequestsRoute() {
  return (
    <OperationsScreens>
      <VanRequestsScreen />
    </OperationsScreens>
  );
}

export function StockCountRoute() {
  const { countId = '' } = useParams();
  return (
    <OperationsScreens>
      <StockCountScreen key={countId} countId={countId} />
    </OperationsScreens>
  );
}

export function OpportunitiesRoute() {
  return (
    <OperationsScreens>
      <OpportunityBoardScreen />
    </OperationsScreens>
  );
}

export function OpportunityRoute() {
  const { opportunityId = '' } = useParams();
  return (
    <OperationsScreens>
      <OpportunityScreen key={opportunityId} opportunityId={opportunityId} />
    </OperationsScreens>
  );
}

export function ActivitiesRoute() {
  return (
    <OperationsScreens>
      <ActivitiesScreen />
    </OperationsScreens>
  );
}

export function LeadConvertRoute() {
  const { leadId = '' } = useParams();
  return (
    <OperationsScreens>
      <LeadConvertScreen key={leadId} leadId={leadId} />
    </OperationsScreens>
  );
}

export function LeadRoute() {
  const { leadId = '' } = useParams();
  return (
    <OperationsScreens>
      <LeadScreen leadId={leadId} />
    </OperationsScreens>
  );
}

export function CustomersRoute() {
  return (
    <OperationsScreens>
      <CustomerListScreen />
    </OperationsScreens>
  );
}

export function CustomerRoute() {
  const { customerId = '' } = useParams();
  useCustomerChrome(customerId);
  return (
    <OperationsScreens>
      <CustomerScreen key={customerId} customerId={customerId} />
    </OperationsScreens>
  );
}

export function SiteRoute() {
  const { siteId = '' } = useParams();
  useSiteChrome(siteId);
  return (
    <OperationsScreens>
      <SiteScreen key={siteId} siteId={siteId} />
    </OperationsScreens>
  );
}

export function JobTypesRoute() {
  return (
    <OperationsScreens>
      <JobTypesScreen />
    </OperationsScreens>
  );
}

export function ImportsRoute() {
  return (
    <OperationsScreens>
      <ImportsScreen />
    </OperationsScreens>
  );
}

export function TimesheetsRoute() {
  return (
    <OperationsScreens>
      <TimesheetsScreen />
    </OperationsScreens>
  );
}

export function SuppliersRoute() {
  return (
    <OperationsScreens>
      <SupplierListScreen />
    </OperationsScreens>
  );
}

export function SupplierRoute() {
  const { supplierId = '' } = useParams();
  return (
    <OperationsScreens>
      <SupplierScreen key={supplierId} supplierId={supplierId} />
    </OperationsScreens>
  );
}

export function PurchaseOrdersRoute() {
  return (
    <OperationsScreens>
      <OrderListScreen />
    </OperationsScreens>
  );
}

export function PurchaseOrderRoute() {
  const { orderId = '' } = useParams();
  return (
    <OperationsScreens>
      <OrderScreen key={orderId} orderId={orderId} />
    </OperationsScreens>
  );
}

export function BomsRoute() {
  return (
    <OperationsScreens>
      <BomListScreen />
    </OperationsScreens>
  );
}

export function BomRoute() {
  const { itemId = '' } = useParams();
  return (
    <OperationsScreens>
      <BomScreen key={itemId} itemId={itemId} />
    </OperationsScreens>
  );
}

export function AssemblyOrdersRoute() {
  return (
    <OperationsScreens>
      <AssemblyOrderListScreen />
    </OperationsScreens>
  );
}

export function AssemblyOrderRoute() {
  const { orderId = '' } = useParams();
  return (
    <OperationsScreens>
      <AssemblyOrderScreen key={orderId} orderId={orderId} />
    </OperationsScreens>
  );
}

export function MaterialPlansRoute() {
  return (
    <OperationsScreens>
      <MaterialPlanListScreen />
    </OperationsScreens>
  );
}

export function MaterialPlanRoute() {
  const { planId = '' } = useParams();
  return (
    <OperationsScreens>
      <MaterialPlanScreen key={planId} planId={planId} />
    </OperationsScreens>
  );
}

export function QuotesRoute() {
  return (
    <OperationsScreens>
      <QuoteListScreen />
    </OperationsScreens>
  );
}

export function QuoteRoute() {
  const { quoteId = '' } = useParams();
  return (
    <OperationsScreens>
      <QuoteScreen key={quoteId} quoteId={quoteId} />
    </OperationsScreens>
  );
}

export function SalesOrdersRoute() {
  return (
    <OperationsScreens>
      <SalesOrderListScreen />
    </OperationsScreens>
  );
}

export function SalesOrderRoute() {
  const { orderId = '' } = useParams();
  return (
    <OperationsScreens>
      <SalesOrderScreen key={orderId} orderId={orderId} />
    </OperationsScreens>
  );
}

/** A delivery note, to print (eighth round; ADR-0012). */
export function DeliveryNoteRoute() {
  const { orderId = '', deliveryId = '' } = useParams();
  return (
    <OperationsScreens>
      <DeliveryNoteScreen key={deliveryId} orderId={orderId} deliveryId={deliveryId} />
    </OperationsScreens>
  );
}

export function InvoicesRoute() {
  return (
    <OperationsScreens>
      <InvoiceListScreen />
    </OperationsScreens>
  );
}

export function InvoiceRoute() {
  const { invoiceId = '' } = useParams();
  return (
    <OperationsScreens>
      <InvoiceScreen key={invoiceId} invoiceId={invoiceId} />
    </OperationsScreens>
  );
}

export function PaymentsRoute() {
  return (
    <OperationsScreens>
      <PaymentListScreen />
    </OperationsScreens>
  );
}

export function PaymentRoute() {
  const { paymentId = '' } = useParams();
  return (
    <OperationsScreens>
      <PaymentScreen key={paymentId} paymentId={paymentId} />
    </OperationsScreens>
  );
}

export function FinanceSettingsRoute() {
  return (
    <OperationsScreens>
      <FinanceSettingsScreen />
    </OperationsScreens>
  );
}

/** The dashboard's list of assets whose warranty ends soon (E3). */
export function WarrantyAlerts() {
  return (
    <OperationsScreens>
      <WarrantyAlertsPanel />
    </OperationsScreens>
  );
}

export function AssetsRoute() {
  // `?warranty=expiring` opens the register filtered, as the dashboard's list does.
  const [search] = useSearchParams();
  const filter = search.get('warranty');
  const warranty = filter === 'expiring' || filter === 'expired' ? filter : '';
  return (
    <OperationsScreens>
      <AssetListScreen key={warranty} initialWarranty={warranty} />
    </OperationsScreens>
  );
}

export function AssetRoute() {
  const { assetId = '' } = useParams();
  return (
    <OperationsScreens>
      <AssetScreen key={assetId} assetId={assetId} />
    </OperationsScreens>
  );
}

/** The general ledger (CRM/ERP plan, phase A1; ADR-0009). */
export function LedgerRoute() {
  return (
    <OperationsScreens>
      <LedgerHomeScreen />
    </OperationsScreens>
  );
}

export function LedgerAccountsRoute() {
  return (
    <OperationsScreens>
      <LedgerAccountsScreen />
    </OperationsScreens>
  );
}

export function JournalsRoute() {
  return (
    <OperationsScreens>
      <JournalListScreen />
    </OperationsScreens>
  );
}

export function NewJournalRoute() {
  // `?kind=opening` drafts the opening balances rather than a manual journal.
  const [search] = useSearchParams();
  const opening = search.get('kind') === 'opening';
  return (
    <OperationsScreens>
      <JournalEditorScreen key={String(opening)} opening={opening} />
    </OperationsScreens>
  );
}

export function JournalRoute() {
  const { journalId = '' } = useParams();
  return (
    <OperationsScreens>
      <JournalScreen key={journalId} journalId={journalId} />
    </OperationsScreens>
  );
}

export function EditJournalRoute() {
  const { journalId = '' } = useParams();
  return (
    <OperationsScreens>
      <JournalEditorScreen key={journalId} journalId={journalId} />
    </OperationsScreens>
  );
}

export function UnpostedRoute() {
  return (
    <OperationsScreens>
      <UnpostedListScreen />
    </OperationsScreens>
  );
}

export function UnpostedItemRoute() {
  const { postingId = '' } = useParams();
  return (
    <OperationsScreens>
      <UnpostedScreen key={postingId} postingId={postingId} />
    </OperationsScreens>
  );
}

export function LedgerPeriodsRoute() {
  return (
    <OperationsScreens>
      <LedgerPeriodsScreen />
    </OperationsScreens>
  );
}

export function LedgerReportsRoute() {
  return (
    <OperationsScreens>
      <LedgerReportsScreen />
    </OperationsScreens>
  );
}

export function LedgerSettingsRoute() {
  return (
    <OperationsScreens>
      <LedgerSettingsScreen />
    </OperationsScreens>
  );
}

/** HR: employee profiles (seventh round; ADR-0010). */
export function EmployeesRoute() {
  return (
    <OperationsScreens>
      <EmployeeListScreen />
    </OperationsScreens>
  );
}

export function NewEmployeeRoute() {
  return (
    <OperationsScreens>
      <EmployeeEditorScreen />
    </OperationsScreens>
  );
}

export function EmployeeRoute() {
  const { employeeId = '' } = useParams();
  return (
    <OperationsScreens>
      <EmployeeScreen key={employeeId} employeeId={employeeId} />
    </OperationsScreens>
  );
}

export function EditEmployeeRoute() {
  const { employeeId = '' } = useParams();
  return (
    <OperationsScreens>
      <EmployeeEditorScreen key={employeeId} employeeId={employeeId} />
    </OperationsScreens>
  );
}

export function MyProfileRoute() {
  return (
    <OperationsScreens>
      <MyProfileScreen />
    </OperationsScreens>
  );
}

/** HR: staff expense claims (seventh round; ADR-0010). */
export function MyExpenseClaimsRoute() {
  return (
    <OperationsScreens>
      <MyExpenseClaimsScreen />
    </OperationsScreens>
  );
}

export function NewExpenseClaimRoute() {
  return (
    <OperationsScreens>
      <NewExpenseClaimScreen />
    </OperationsScreens>
  );
}

export function ExpenseClaimRoute() {
  const { claimId = '' } = useParams();
  return (
    <OperationsScreens>
      <ExpenseClaimScreen key={claimId} claimId={claimId} />
    </OperationsScreens>
  );
}

export function ExpenseClaimsRoute() {
  return (
    <OperationsScreens>
      <ExpenseClaimsScreen />
    </OperationsScreens>
  );
}

export function ExpenseCategoriesRoute() {
  return (
    <OperationsScreens>
      <ExpenseCategoriesScreen />
    </OperationsScreens>
  );
}

/** HR: Egyptian payroll (seventh round; ADR-0010). */
export function PayRunsRoute() {
  return (
    <OperationsScreens>
      <PayRunsScreen />
    </OperationsScreens>
  );
}

export function PayRunRoute() {
  const { runId = '' } = useParams();
  return (
    <OperationsScreens>
      <PayRunScreen key={runId} runId={runId} />
    </OperationsScreens>
  );
}

export function PayrollRulesRoute() {
  return (
    <OperationsScreens>
      <PayrollRulesScreen />
    </OperationsScreens>
  );
}

export function MyPayslipsRoute() {
  return (
    <OperationsScreens>
      <MyPayslipsScreen />
    </OperationsScreens>
  );
}
