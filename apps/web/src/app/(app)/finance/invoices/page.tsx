'use client';

import { InvoiceListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Invoices: what customers owe. */
export default function InvoicesPage() {
  return (
    <OperationsScreens>
      <InvoiceListScreen />
    </OperationsScreens>
  );
}
