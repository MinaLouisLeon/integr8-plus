'use client';

import { SalesOrderListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Sales orders: what the company has promised to deliver. */
export default function SalesOrdersPage() {
  return (
    <OperationsScreens>
      <SalesOrderListScreen />
    </OperationsScreens>
  );
}
