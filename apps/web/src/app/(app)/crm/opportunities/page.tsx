'use client';

import { OpportunityBoardScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Opportunities: the pipeline board and the list. */
export default function OpportunitiesPage() {
  return (
    <OperationsScreens>
      <OpportunityBoardScreen />
    </OperationsScreens>
  );
}
