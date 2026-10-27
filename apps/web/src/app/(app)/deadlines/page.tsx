'use client';

import { DeadlinesScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** How jobs did against the response and completion deadlines, and the rules (P27). */
export default function DeadlinesPage() {
  return (
    <OperationsScreens>
      <DeadlinesScreen />
    </OperationsScreens>
  );
}
