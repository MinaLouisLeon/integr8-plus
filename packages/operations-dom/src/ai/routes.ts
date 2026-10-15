import type { OperationsConfig } from '../api.js';

type Paths = OperationsConfig['paths'];

/**
 * Where an assistant citation or a finished action points in the host app.
 *
 * The server names a route by a key it shares with the help library
 * (`workOrders`, `ledgerReports`), never by a URL: the web and desktop apps
 * live at different addresses. A key this app has no page for yields
 * `undefined`, and the screen shows the citation without a link rather than
 * guessing one.
 */
export function appRoutePath(paths: Paths, route: string | null): string | undefined {
  switch (route) {
    case 'dashboard':
      return paths.dashboard;
    case 'workOrders':
      return paths.workOrders;
    case 'customers':
      return paths.customers;
    case 'submissions':
      return paths.submissions;
    case 'forms':
      return paths.forms;
    case 'people':
      return paths.people;
    case 'companySettings':
      return paths.companySettings;
    case 'billing':
      return paths.billing;
    case 'leads':
      return paths.crmLeads;
    case 'opportunities':
      return paths.crmOpportunities;
    case 'activities':
      return paths.crmActivities;
    case 'quotes':
      return paths.quotes;
    case 'invoices':
      return paths.invoices;
    case 'payments':
      return paths.payments;
    case 'inventory':
      return paths.inventory;
    case 'stockLocations':
      return paths.stockLocations;
    case 'purchaseOrders':
      return paths.purchaseOrders;
    case 'boms':
      return paths.boms;
    case 'ledger':
      return paths.ledger;
    case 'ledgerReports':
      return paths.ledgerReports;
    case 'assets':
      return paths.assets;
    case 'employees':
      return paths.employees;
    case 'myExpenses':
      return paths.myExpenseClaims;
    case 'payRuns':
      return paths.payRuns;
    default:
      return undefined;
  }
}

/**
 * The record an action made or changed, when this app has a page for one of
 * its kind; otherwise the list the route names, or nothing.
 */
export function recordPath(paths: Paths, route: string, id: string): string | undefined {
  switch (route) {
    case 'customers':
      return paths.customer(id);
    case 'workOrders':
      return paths.workOrder(id);
    case 'opportunities':
      return paths.crmOpportunity(id);
    default:
      return appRoutePath(paths, route);
  }
}
