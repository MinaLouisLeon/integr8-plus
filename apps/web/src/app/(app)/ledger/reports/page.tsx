'use client';

import { LedgerReportsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The ledger’s reports, printable and downloadable as CSV. */
export default function LedgerReportsPage() {
  return (
    <OperationsScreens>
      <LedgerReportsScreen />
    </OperationsScreens>
  );
}
