'use client';

import { ExpenseClaimScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One expense claim. */
export default function ExpenseClaimPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <ExpenseClaimScreen key={id} claimId={id} />
    </OperationsScreens>
  );
}
