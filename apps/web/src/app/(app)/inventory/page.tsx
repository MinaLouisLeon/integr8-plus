'use client';

import { InventoryOverviewScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Inventory at a glance. */
export default function InventoryPage() {
  return (
    <OperationsScreens>
      <InventoryOverviewScreen />
    </OperationsScreens>
  );
}
