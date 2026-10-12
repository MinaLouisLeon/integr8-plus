'use client';

import { NewExpenseClaimScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Claiming an expense back, with its receipts. */
export default function NewExpenseClaimPage() {
  return (
    <OperationsScreens>
      <NewExpenseClaimScreen />
    </OperationsScreens>
  );
}
