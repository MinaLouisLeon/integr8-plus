'use client';

import { LeadListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Leads. */
export default function LeadsPage() {
  return (
    <OperationsScreens>
      <LeadListScreen />
    </OperationsScreens>
  );
}
