'use client';

import { PaymentScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One payment received. */
export default function PaymentPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <PaymentScreen key={id} paymentId={id} />
    </OperationsScreens>
  );
}
