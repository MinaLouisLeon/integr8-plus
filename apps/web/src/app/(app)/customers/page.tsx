'use client';

import { CustomerListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Customers. */
export default function CustomersPage() {
  return (
    <OperationsScreens>
      <CustomerListScreen />
    </OperationsScreens>
  );
}
