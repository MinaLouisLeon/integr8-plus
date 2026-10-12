'use client';

import { LedgerHomeScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The general ledger: set-up, and the way into everything else. */
export default function LedgerPage() {
  return (
    <OperationsScreens>
      <LedgerHomeScreen />
    </OperationsScreens>
  );
}
