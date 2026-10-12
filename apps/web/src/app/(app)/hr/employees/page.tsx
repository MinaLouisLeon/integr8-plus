'use client';

import { EmployeeListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Everybody the company employs (ADR-0010). */
export default function EmployeesPage() {
  return (
    <OperationsScreens>
      <EmployeeListScreen />
    </OperationsScreens>
  );
}
