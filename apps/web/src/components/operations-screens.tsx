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
      navigate: (to) => router.push(to),
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
