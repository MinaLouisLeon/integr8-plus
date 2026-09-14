'use client';

import { WorkOrderScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One job, with how to get in first. */
export default function WorkOrderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <WorkOrderScreen key={id} workOrderId={id} />
    </OperationsScreens>
  );
}
