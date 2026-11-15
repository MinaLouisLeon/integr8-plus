import { createI18n, I18nextProvider, type Locale } from '@integr8/i18n';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { AppFrame } from '~/components/app-frame';
import { ClientTooOldBanner } from '~/components/client-too-old-banner';
import { CompanyBrand } from '~/components/company-brand';
import { ContextMenuProvider } from '~/components/context-menu';
import { ShellChromeProvider } from '~/components/shell-chrome';
import { LoadingState } from '~/components/ui';
import {
  applyPreferences,
  readPreferences,
  writePreferences,
  type Preferences,
} from '~/lib/preferences';
import { APP_FLAVOR } from '~/lib/env';
import { session, whenSignedOut } from '~/lib/session';
import { afterCompanySignOut } from '~/lib/staff-bridge';
import { FormBuilderRoute } from '~/features/forms/routes/form-builder';
import { ChangePasswordRoute } from '~/routes/change-password';
import { FormVersionRoute } from '~/features/forms/routes/form-version';
import { FormsListRoute } from '~/features/forms/routes/forms-list';
import {
  AssistantRoute,
  CrmRoute,
  ActivitiesRoute,
  InventoryRoute,
  ItemRoute,
  ItemsRoute,
  PurchaseOrderRoute,
  PurchaseOrdersRoute,
  BomRoute,
  BomVersionRoute,
  BomsRoute,
  CrmReportsRoute,
  PartsUsageRoute,
  PipelineRoute,
  PipelinesRoute,
  AssemblyOrderRoute,
  AssemblyOrdersRoute,
  MaterialPlanRoute,
  MaterialPlansRoute,
  QuoteRoute,
  QuotesRoute,
  SalesOrderRoute,
  SalesOrdersRoute,
  DeliveryNoteRoute,
  ReorderRoute,
  ReorderStartRoute,
  VanRequestsRoute,
  LotLookupRoute,
  LotRoute,
  FinanceSettingsRoute,
  LedgerRoute,
  LedgerAccountsRoute,
  JournalsRoute,
  NewJournalRoute,
  JournalRoute,
  EditJournalRoute,
  UnpostedRoute,
  UnpostedItemRoute,
  LedgerPeriodsRoute,
  LedgerReportsRoute,
  LedgerSettingsRoute,
  EmployeesRoute,
  NewEmployeeRoute,
  EmployeeRoute,
  EditEmployeeRoute,
  MyProfileRoute,
  MyExpenseClaimsRoute,
  NewExpenseClaimRoute,
  ExpenseClaimRoute,
  ExpenseClaimsRoute,
  ExpenseCategoriesRoute,
  PayRunsRoute,
  PayRunRoute,
  PayrollRulesRoute,
  MyPayslipsRoute,
  AssetRoute,
  AssetTagRoute,
  AssetsRoute,
  DocumentRoute,
  DocumentsRoute,
  EtaDocumentRoute,
  EtaRoute,
  EtaSigningRoute,
  InvoiceRoute,
  InvoicesRoute,
  PaymentRoute,
  PaymentsRoute,
  StockCountRoute,
  StockLocationRoute,
  StockLocationsRoute,
  SupplierRoute,
  SuppliersRoute,
  LeadConvertRoute,
  OpportunitiesRoute,
  OpportunityRoute,
  LeadRoute,
  LeadsRoute,
  CustomerRoute,
  CustomersRoute,
  CompanyRolesRoute,
  ImportsRoute,
  JobTypesRoute,
  NewWorkOrderRoute,
  QualificationsRoute,
  ScheduleRoute,
  MaintenanceRoute,
  DeadlinesRoute,
  ContractsRoute,
  ContractRoute,
  SiteRoute,
  TimesheetsRoute,
  WorkOrderRoute,
  WorkOrdersRoute,
} from '~/features/operations/screens';
import { FillRoute, SubmissionRoute, SubmissionsRoute } from '~/features/submissions/screens';
import { BillingRoute } from '~/features/company/billing';
import { CompanySettingsRoute } from '~/features/company/company-settings';
import { GetStartedRoute } from '~/features/company/get-started';
import { PeopleRoute } from '~/features/company/people';
import { StorageRoute } from '~/features/company/storage';
import { WebsiteAccessRoute } from '~/features/company/website-access';
import { BrandingRoute } from '~/routes/branding';
import { DashboardRoute } from '~/routes/dashboard';
import { EInvoicingSwitchRoute } from '~/routes/e-invoicing-switch';
import { SignInRoute } from '~/routes/sign-in';

/**
 * The desktop app.
 *
 * A hash router rather than a browser router: the Tauri window loads the bundle
 * from a custom protocol where path-based routing needs the shell to cooperate,
 * and a hash route behaves identically in both homes. Keeping the two identical
 * is P05's second exit criterion, and this is the cheapest way to hold it.
 *
 * Every signed-in route is a child of one `RequireSession` layout route, which
 * puts the dashboard frame — side menu, top bar, impersonation banner — around
 * the screen and keeps it mounted from one screen to the next, so moving
 * between sections redraws the screen and not the menu. The sign-in screen
 * stands alone.
 */

/**
 * The staff dashboard (P42), for the staff build and the development build
 * only. Vite inlines the flavour, so in a company's build this is `null` and
 * the dashboard's module is left out of the bundle altogether
 * (`scripts/check-company-bundle.mjs` checks).
 */
const PlatformApp =
  import.meta.env.VITE_APP_FLAVOR === 'company'
    ? null
    : lazy(() => import('~/features/platform/routes'));

/** Where the app opens: the staff dashboard in the staff build, the company's elsewhere. */
const HOME = APP_FLAVOR === 'staff' ? '/platform' : '/dashboard';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

/** The signed-in screens, each the element of a route. */
const SIGNED_IN_ROUTES: readonly { path: string; element: ReactNode }[] = [
  { path: '/dashboard', element: <DashboardRoute /> },
  { path: '/assistant', element: <AssistantRoute /> },
  { path: '/forms', element: <FormsListRoute /> },
  { path: '/forms/:formId', element: <FormBuilderRoute /> },
  { path: '/forms/:formId/versions/:versionId', element: <FormVersionRoute /> },
  { path: '/fill', element: <FillRoute /> },
  { path: '/submissions', element: <SubmissionsRoute /> },
  { path: '/submissions/:submissionId', element: <SubmissionRoute /> },
  { path: '/work-orders', element: <WorkOrdersRoute /> },
  { path: '/work-orders/new', element: <NewWorkOrderRoute /> },
  { path: '/work-orders/:workOrderId', element: <WorkOrderRoute /> },
  { path: '/crm', element: <CrmRoute /> },
  { path: '/crm/leads', element: <LeadsRoute /> },
  { path: '/crm/leads/:leadId', element: <LeadRoute /> },
  { path: '/crm/leads/:leadId/convert', element: <LeadConvertRoute /> },
  { path: '/crm/opportunities', element: <OpportunitiesRoute /> },
  { path: '/crm/opportunities/:opportunityId', element: <OpportunityRoute /> },
  { path: '/crm/activities', element: <ActivitiesRoute /> },
  { path: '/crm/pipelines', element: <PipelinesRoute /> },
  { path: '/crm/pipelines/:pipelineId', element: <PipelineRoute /> },
  { path: '/crm/reports', element: <CrmReportsRoute /> },
  { path: '/inventory', element: <InventoryRoute /> },
  { path: '/inventory/items', element: <ItemsRoute /> },
  { path: '/inventory/items/:itemId', element: <ItemRoute /> },
  { path: '/inventory/locations', element: <StockLocationsRoute /> },
  { path: '/inventory/locations/:locationId', element: <StockLocationRoute /> },
  { path: '/inventory/counts/:countId', element: <StockCountRoute /> },
  { path: '/inventory/parts-usage', element: <PartsUsageRoute /> },
  { path: '/inventory/locations/:locationId/reorder', element: <ReorderRoute /> },
  { path: '/inventory/van-requests', element: <VanRequestsRoute /> },
  { path: '/inventory/lots', element: <LotLookupRoute /> },
  { path: '/inventory/lots/:lotId', element: <LotRoute /> },
  { path: '/purchasing/suppliers', element: <SuppliersRoute /> },
  { path: '/purchasing/suppliers/:supplierId', element: <SupplierRoute /> },
  { path: '/purchasing/orders', element: <PurchaseOrdersRoute /> },
  { path: '/purchasing/orders/:orderId', element: <PurchaseOrderRoute /> },
  { path: '/purchasing/reorder', element: <ReorderStartRoute /> },
  { path: '/manufacturing/boms', element: <BomsRoute /> },
  { path: '/manufacturing/boms/:itemId', element: <BomRoute /> },
  { path: '/manufacturing/boms/versions/:bomId', element: <BomVersionRoute /> },
  { path: '/manufacturing/orders', element: <AssemblyOrdersRoute /> },
  { path: '/manufacturing/orders/:orderId', element: <AssemblyOrderRoute /> },
  { path: '/manufacturing/plans', element: <MaterialPlansRoute /> },
  { path: '/manufacturing/plans/:planId', element: <MaterialPlanRoute /> },
  { path: '/sales/quotes', element: <QuotesRoute /> },
  { path: '/sales/quotes/:quoteId', element: <QuoteRoute /> },
  { path: '/sales/orders', element: <SalesOrdersRoute /> },
  { path: '/sales/orders/:orderId', element: <SalesOrderRoute /> },
  { path: '/sales/orders/:orderId/deliveries/:deliveryId', element: <DeliveryNoteRoute /> },
  { path: '/finance/invoices', element: <InvoicesRoute /> },
  { path: '/finance/invoices/:invoiceId', element: <InvoiceRoute /> },
  { path: '/finance/payments', element: <PaymentsRoute /> },
  { path: '/finance/payments/:paymentId', element: <PaymentRoute /> },
  { path: '/finance/settings', element: <FinanceSettingsRoute /> },
  { path: '/ledger', element: <LedgerRoute /> },
  { path: '/ledger/accounts', element: <LedgerAccountsRoute /> },
  { path: '/ledger/journals', element: <JournalsRoute /> },
  { path: '/ledger/journals/new', element: <NewJournalRoute /> },
  { path: '/ledger/journals/:journalId', element: <JournalRoute /> },
  { path: '/ledger/journals/:journalId/edit', element: <EditJournalRoute /> },
  { path: '/ledger/unposted', element: <UnpostedRoute /> },
  { path: '/ledger/unposted/:postingId', element: <UnpostedItemRoute /> },
  { path: '/ledger/periods', element: <LedgerPeriodsRoute /> },
  { path: '/ledger/reports', element: <LedgerReportsRoute /> },
  { path: '/ledger/settings', element: <LedgerSettingsRoute /> },
  { path: '/hr/employees', element: <EmployeesRoute /> },
  { path: '/hr/employees/new', element: <NewEmployeeRoute /> },
  { path: '/hr/employees/:employeeId', element: <EmployeeRoute /> },
  { path: '/hr/employees/:employeeId/edit', element: <EditEmployeeRoute /> },
  { path: '/hr/me', element: <MyProfileRoute /> },
  { path: '/hr/expenses', element: <MyExpenseClaimsRoute /> },
  { path: '/hr/expenses/new', element: <NewExpenseClaimRoute /> },
  { path: '/hr/expenses/:claimId', element: <ExpenseClaimRoute /> },
  { path: '/hr/claims', element: <ExpenseClaimsRoute /> },
  { path: '/hr/claims/categories', element: <ExpenseCategoriesRoute /> },
  { path: '/hr/pay-runs', element: <PayRunsRoute /> },
  { path: '/hr/pay-runs/:runId', element: <PayRunRoute /> },
  { path: '/hr/payroll-rules', element: <PayrollRulesRoute /> },
  { path: '/hr/payslips', element: <MyPayslipsRoute /> },
  { path: '/assets', element: <AssetsRoute /> },
  { path: '/documents', element: <DocumentsRoute /> },
  { path: '/documents/:documentId', element: <DocumentRoute /> },
  { path: '/e-invoicing', element: <EtaRoute /> },
  { path: '/e-invoicing/signing', element: <EtaSigningRoute /> },
  { path: '/e-invoicing/documents/:documentId', element: <EtaDocumentRoute /> },
  { path: '/assets/:assetId', element: <AssetRoute /> },
  { path: '/assets/tag/:code', element: <AssetTagRoute /> },
  { path: '/customers', element: <CustomersRoute /> },
  { path: '/customers/:customerId', element: <CustomerRoute /> },
  { path: '/sites/:siteId', element: <SiteRoute /> },
  { path: '/settings/job-types', element: <JobTypesRoute /> },
  { path: '/settings/branding', element: <BrandingRoute /> },
  { path: '/settings/e-invoicing', element: <EInvoicingSwitchRoute /> },
  { path: '/get-started', element: <GetStartedRoute /> },
  { path: '/settings/people', element: <PeopleRoute /> },
  { path: '/settings/company', element: <CompanySettingsRoute /> },
  { path: '/settings/website-access', element: <WebsiteAccessRoute /> },
  { path: '/storage', element: <StorageRoute /> },
  { path: '/billing', element: <BillingRoute /> },
  { path: '/settings/password', element: <ChangePasswordRoute /> },
  { path: '/settings/roles', element: <CompanyRolesRoute /> },
  { path: '/imports', element: <ImportsRoute /> },
  { path: '/timesheets', element: <TimesheetsRoute /> },
  { path: '/schedule', element: <ScheduleRoute /> },
  { path: '/qualifications', element: <QualificationsRoute /> },
  { path: '/maintenance', element: <MaintenanceRoute /> },
  { path: '/deadlines', element: <DeadlinesRoute /> },
  { path: '/contracts', element: <ContractsRoute /> },
  { path: '/contracts/:contractId', element: <ContractRoute /> },
];

export function App() {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [i18n, setI18n] = useState(() => createI18n({ locale: preferences.locale }));

  const changeLocale = useCallback((locale: Locale) => {
    setPreferences((current) => {
      const merged = { ...current, locale };
      writePreferences({ locale });
      applyPreferences(merged);
      return merged;
    });
    setI18n(createI18n({ locale }));
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ClientTooOldBanner />
        <HashRouter>
          <ContextMenuProvider>
            <Routes>
              <Route path="/sign-in" element={<SignInRoute />} />
              {PlatformApp === null ? null : (
                <Route
                  path="/platform/*"
                  element={
                    <Suspense fallback={<LoadingState />}>
                      <PlatformApp locale={preferences.locale} onLocaleChange={changeLocale} />
                    </Suspense>
                  }
                />
              )}
              <Route
                element={
                  <RequireSession locale={preferences.locale} onLocaleChange={changeLocale} />
                }
              >
                {SIGNED_IN_ROUTES.map(({ path, element }) => (
                  <Route key={path} path={path} element={element} />
                ))}
              </Route>
              <Route path="*" element={<Navigate to={HOME} replace />} />
            </Routes>
          </ContextMenuProvider>
        </HashRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

/**
 * Redirects to sign-in when there is no usable session, and frames the screen
 * when there is one.
 *
 * "Usable" includes a device holding a live offline grant whose refresh token
 * has lapsed — an engineer a week into a job with no signal still has to get
 * in.
 */
function RequireSession({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [state, setState] = useState<'checking' | 'allowed'>('checking');

  useEffect(() => {
    let cancelled = false;

    whenSignedOut(() => {
      // Whoever signs in next starts from nothing of this session's.
      queries.clear();
      // Staff working inside a company go back to the dashboard (P42).
      void navigate(afterCompanySignOut(), { replace: true });
    });

    void (async () => {
      let allowed = await session().isSignedIn();
      // A company session in the staff app exists only beside a staff
      // session, which is held in memory (P42, D2). After a restart there is
      // none, so a company session left in the credential store is ended
      // rather than let in without the staff sign-in.
      if (allowed && APP_FLAVOR === 'staff' && afterCompanySignOut() === '/sign-in') {
        await session().signOut();
        allowed = false;
      }
      if (cancelled) {
        return;
      }

      if (allowed) {
        setState('allowed');
      } else {
        void navigate('/sign-in', { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, queries]);

  // The frame, the banner and the company's brand sit inside the guard, so
  // they are only ever asked for when there is a session to describe; the
  // brand's variables are lifted on sign-out.
  return state === 'checking' ? (
    <div className="flex h-dvh items-center justify-center">
      <LoadingState />
    </div>
  ) : (
    <ShellChromeProvider>
      <CompanyBrand />
      <AppFrame locale={locale} onLocaleChange={onLocaleChange}>
        <Outlet />
      </AppFrame>
    </ShellChromeProvider>
  );
}
