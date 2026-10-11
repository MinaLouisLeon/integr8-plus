'use client';

import { FinanceSettingsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** What the company prints on its invoices. */
export default function FinanceSettingsPage() {
  return (
    <OperationsScreens>
      <FinanceSettingsScreen />
    </OperationsScreens>
  );
}
