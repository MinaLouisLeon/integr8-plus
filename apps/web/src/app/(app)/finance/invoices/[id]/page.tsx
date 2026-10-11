'use client';

import { InvoiceScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One invoice. */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <InvoiceScreen key={id} invoiceId={id} />
    </OperationsScreens>
  );
}
