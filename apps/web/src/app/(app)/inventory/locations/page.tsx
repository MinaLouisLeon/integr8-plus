'use client';

import { LocationListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Stock locations. */
export default function StockLocationsPage() {
  return (
    <OperationsScreens>
      <LocationListScreen />
    </OperationsScreens>
  );
}
