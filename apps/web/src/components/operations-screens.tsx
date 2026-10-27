'use client';

import { useTranslation } from '@integr8/i18n';
import { type OperationsConfig, OperationsContext } from '@integr8/operations-dom';
import { useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { apiClient } from '~/lib/session';

/**
 * Where site maps load tiles from: `NEXT_PUBLIC_MAP_TILES_URL` with
 * `NEXT_PUBLIC_MAP_TILES_ATTRIBUTION`, such as a Mapbox raster style. In
 * development only, OpenStreetMap's own tiles stand in; their usage policy does
 * not allow a product to rely on them.
 */
const MAP_TILES: OperationsConfig['mapTiles'] =
  process.env.NEXT_PUBLIC_MAP_TILES_URL !== undefined
    ? {
        url: process.env.NEXT_PUBLIC_MAP_TILES_URL,
        attribution: process.env.NEXT_PUBLIC_MAP_TILES_ATTRIBUTION ?? '',
      }
    : process.env.NODE_ENV === 'development'
      ? {
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attribution: '© OpenStreetMap contributors',
        }
      : undefined;

/**
 * Customers, sites, job types, work orders and imports, hosted by the web app.
 * Shared with the desktop app (`@integr8/operations-dom`); the web app supplies
 * its cookie-backed session client and Next routing.
 */
export function OperationsScreens({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { i18n } = useTranslation();

  const config = useMemo<OperationsConfig>(
    () => ({
      client: apiClient(),
      locale: i18n.language,
      navigate: (to, options) => (options?.replace === true ? router.replace(to) : router.push(to)),
      paths: {
        workOrders: '/work-orders',
        newWorkOrder: (options) =>
          options?.customerId === undefined
            ? '/work-orders/new'
            : `/work-orders/new?customerId=${options.customerId}`,
        workOrder: (id) => `/work-orders/${id}`,
        qualifications: '/qualifications',
        maintenance: '/maintenance',
        contracts: '/contracts',
        contract: (id) => `/contracts/${id}`,
        deadlines: '/deadlines',
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
        crmPipelines: '/crm/pipelines',
        crmPipeline: (id) => `/crm/pipelines/${id}`,
        crmReports: '/crm/reports',
        inventory: '/inventory',
        partsUsage: '/inventory/parts-usage',
        items: '/inventory/items',
        item: (id) => `/inventory/items/${id}`,
        stockLocations: '/inventory/locations',
        stockLocation: (id) => `/inventory/locations/${id}`,
        stockCount: (id) => `/inventory/counts/${id}`,
        reorder: (locationId) => `/inventory/locations/${locationId}/reorder`,
        vanRequests: '/inventory/van-requests',
        lots: '/inventory/lots',
        lot: (id) => `/inventory/lots/${id}`,
        suppliers: '/purchasing/suppliers',
        supplier: (id) => `/purchasing/suppliers/${id}`,
        purchaseOrders: '/purchasing/orders',
        purchaseOrder: (id) => `/purchasing/orders/${id}`,
        boms: '/manufacturing/boms',
        bom: (itemId) => `/manufacturing/boms/${itemId}`,
        bomVersion: (bomId) => `/manufacturing/boms/versions/${bomId}`,
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
        documents: '/documents',
        document: (id) => `/documents/${id}`,
        eInvoicing: '/e-invoicing',
        etaDocument: (id) => `/e-invoicing/documents/${id}`,
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
        assistant: '/assistant',
        people: '/settings/people',
        companySettings: '/settings/company',
        websiteAccess: '/settings/website-access',
        billing: '/billing',
        submissions: '/submissions',
      },
      download: saveFile,
      ...(MAP_TILES === undefined ? {} : { mapTiles: MAP_TILES }),
    }),
    [router, i18n.language],
  );

  return <OperationsContext.Provider value={config}>{children}</OperationsContext.Provider>;
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
