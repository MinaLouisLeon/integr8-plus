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
}

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

export const keys = {
  me: ['me'] as const,
  members: ['members'] as const,
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
