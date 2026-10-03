'use client';

import { WorkOrderFormScreen } from '@integr8/operations-dom';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { OperationsScreens } from '~/components/operations-screens';

/** A new work order, optionally for the customer named in `?customerId=`. */
export default function NewWorkOrderPage() {
  return (
    <OperationsScreens>
      <Suspense>
        <NewWorkOrder />
      </Suspense>
    </OperationsScreens>
  );
}

function NewWorkOrder() {
  const customerId = useSearchParams().get('customerId');
  return <WorkOrderFormScreen {...(customerId === null ? {} : { customerId })} />;
}
