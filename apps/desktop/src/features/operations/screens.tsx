import { useTranslation } from '@integr8/i18n';
import {
  CustomerListScreen,
  CustomerScreen,
  ImportsScreen,
  JobTypesScreen,
  type OperationsConfig,
  OperationsContext,
  SiteScreen,
  WorkOrderFormScreen,
  WorkOrderListScreen,
  WorkOrderScreen,
} from '@integr8/operations-dom';
import { useMemo, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
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
  const config = useMemo<OperationsConfig>(
    () => ({
      client: session().client,
      locale: i18n.language,
      navigate: (to) => void navigate(to),
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
      },
      download: saveFile,
      ...(MAP_TILES === undefined ? {} : { mapTiles: MAP_TILES }),
    }),
    [navigate, i18n.language],
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
  return (
    <OperationsScreens>
      <WorkOrderScreen key={workOrderId} workOrderId={workOrderId} />
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
  return (
    <OperationsScreens>
      <CustomerScreen key={customerId} customerId={customerId} />
    </OperationsScreens>
  );
}

export function SiteRoute() {
  const { siteId = '' } = useParams();
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
