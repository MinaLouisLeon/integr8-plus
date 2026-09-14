'use client';

import { WorkOrderListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Work orders: find, filter, save views, and change many at once. */
export default function WorkOrdersPage() {
  return (
    <OperationsScreens>
      <WorkOrderListScreen />
    </OperationsScreens>
  );
}
