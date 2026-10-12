'use client';

import { EmployeeEditorScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** An employee profile, changed. */
export default function EditEmployeePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <EmployeeEditorScreen key={id} employeeId={id} />
    </OperationsScreens>
  );
}
