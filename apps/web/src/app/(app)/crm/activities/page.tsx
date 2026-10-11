'use client';

import { ActivitiesScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Follow-ups that are due. */
export default function ActivitiesPage() {
  return (
    <OperationsScreens>
      <ActivitiesScreen />
    </OperationsScreens>
  );
}
