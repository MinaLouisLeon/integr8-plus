'use client';

import { PaymentListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Payments received from customers. */
export default function PaymentsPage() {
  return (
    <OperationsScreens>
      <PaymentListScreen />
    </OperationsScreens>
  );
}
