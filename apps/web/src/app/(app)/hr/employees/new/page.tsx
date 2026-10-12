'use client';

import { EmployeeEditorScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** A new employee profile. */
export default function NewEmployeePage() {
  return (
    <OperationsScreens>
      <EmployeeEditorScreen />
    </OperationsScreens>
  );
}
