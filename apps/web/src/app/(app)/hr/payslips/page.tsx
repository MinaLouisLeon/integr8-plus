'use client';

import { MyPayslipsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The signed-in person's own payslips (ADR-0010). */
export default function MyPayslipsPage() {
  return (
    <OperationsScreens>
      <MyPayslipsScreen />
    </OperationsScreens>
  );
}
