'use client';

import { ReorderStartScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The menu's way into reordering: which location's reorder list to open. */
export default function ReorderStartPage() {
  return (
    <OperationsScreens>
      <ReorderStartScreen />
    </OperationsScreens>
  );
}
