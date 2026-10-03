'use client';

import { ImportsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Importing customers, sites and jobs from CSV. */
export default function ImportsPage() {
  return (
    <OperationsScreens>
      <ImportsScreen />
    </OperationsScreens>
  );
}
