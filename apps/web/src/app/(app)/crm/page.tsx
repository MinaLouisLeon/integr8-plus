'use client';

import { CrmOverviewScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The CRM's front page. */
export default function CrmPage() {
  return (
    <OperationsScreens>
      <CrmOverviewScreen />
    </OperationsScreens>
  );
}
