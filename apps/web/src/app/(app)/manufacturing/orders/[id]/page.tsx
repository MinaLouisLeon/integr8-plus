'use client';

import { AssemblyOrderScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One assembly or disassembly order. */
export default function AssemblyOrderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <AssemblyOrderScreen key={id} orderId={id} />
    </OperationsScreens>
  );
}
