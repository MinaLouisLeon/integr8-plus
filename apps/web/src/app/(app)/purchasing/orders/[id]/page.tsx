'use client';

import { OrderScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One purchase order. */
export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <OrderScreen key={id} orderId={id} />
    </OperationsScreens>
  );
}
