'use client';

import { PayRunsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The company's pay runs, for those who keep payroll (ADR-0010). */
export default function PayRunsPage() {
  return (
    <OperationsScreens>
      <PayRunsScreen />
    </OperationsScreens>
  );
}
