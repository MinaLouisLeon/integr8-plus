'use client';

import { SalesOrderScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One sales order. */
export default function SalesOrderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <SalesOrderScreen key={id} orderId={id} />
    </OperationsScreens>
  );
}
