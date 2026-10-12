'use client';

import { VanRequestsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The store's queue of requests to refill vans. */
export default function VanRequestsPage() {
  return (
    <OperationsScreens>
      <VanRequestsScreen />
    </OperationsScreens>
  );
}
