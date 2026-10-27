'use client';

import { ContractScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One service contract: its term, what it covers, its plans and its jobs. */
export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <ContractScreen key={id} contractId={id} />
    </OperationsScreens>
  );
}
