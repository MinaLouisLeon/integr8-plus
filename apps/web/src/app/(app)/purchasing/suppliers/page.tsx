'use client';

import { SupplierListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Suppliers. */
export default function SuppliersPage() {
  return (
    <OperationsScreens>
      <SupplierListScreen />
    </OperationsScreens>
  );
}
