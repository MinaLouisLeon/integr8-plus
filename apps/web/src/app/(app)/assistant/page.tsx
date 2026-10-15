'use client';

import { AssistantScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The Integr8 Plus assistant (docs/ai; ADR-0001). */
export default function AssistantPage() {
  return (
    <OperationsScreens>
      <AssistantScreen />
    </OperationsScreens>
  );
}
