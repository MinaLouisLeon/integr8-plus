'use client';

import { LedgerAccountsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The chart of accounts. */
export default function LedgerAccountsPage() {
  return (
    <OperationsScreens>
      <LedgerAccountsScreen />
    </OperationsScreens>
  );
}
