'use client';

import { ContractsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Service contracts (P27). Renewal reminders link to one contract under this path. */
export default function ContractsPage() {
  return (
    <OperationsScreens>
      <ContractsScreen />
    </OperationsScreens>
  );
}
