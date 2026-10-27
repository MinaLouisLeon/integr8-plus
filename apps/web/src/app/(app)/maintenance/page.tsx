'use client';

import { MaintenanceScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** What the company's maintenance plans have due, made and overdue (P27). */
export default function MaintenancePage() {
  return (
    <OperationsScreens>
      <MaintenanceScreen />
    </OperationsScreens>
  );
}
