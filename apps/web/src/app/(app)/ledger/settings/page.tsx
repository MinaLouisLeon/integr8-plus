'use client';

import { LedgerSettingsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The ledger’s settings. */
export default function LedgerSettingsPage() {
  return (
    <OperationsScreens>
      <LedgerSettingsScreen />
    </OperationsScreens>
  );
}
