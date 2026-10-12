'use client';

import { MaterialPlanListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Material planning runs. */
export default function MaterialPlansPage() {
  return (
    <OperationsScreens>
      <MaterialPlanListScreen />
    </OperationsScreens>
  );
}
