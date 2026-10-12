'use client';

import { PartsUsageScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Parts used on jobs, by engineer, customer or job type. */
export default function PartsUsagePage() {
  return (
    <OperationsScreens>
      <PartsUsageScreen />
    </OperationsScreens>
  );
}
