'use client';

import { EmployeeScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One employee. */
export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <EmployeeScreen key={id} employeeId={id} />
    </OperationsScreens>
  );
}
