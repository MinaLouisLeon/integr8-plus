'use client';

import { OrderListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Purchase orders. */
export default function PurchaseOrdersPage() {
  return (
    <OperationsScreens>
      <OrderListScreen />
    </OperationsScreens>
  );
}
