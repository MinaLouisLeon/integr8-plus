'use client';

import { LedgerPeriodsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Months and fiscal years: locking, closing and reopening. */
export default function LedgerPeriodsPage() {
  return (
    <OperationsScreens>
      <LedgerPeriodsScreen />
    </OperationsScreens>
  );
}
