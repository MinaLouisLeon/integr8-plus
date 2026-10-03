'use client';

import { JobTypesScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Job types and what each carries onto a job. */
export default function JobTypesPage() {
  return (
    <OperationsScreens>
      <JobTypesScreen />
    </OperationsScreens>
  );
}
