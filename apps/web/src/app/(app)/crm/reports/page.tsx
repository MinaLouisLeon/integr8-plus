'use client';

import { CrmReportsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The CRM's figures: quote conversion, win rate and pipeline value. */
export default function CrmReportsPage() {
  return (
    <OperationsScreens>
      <CrmReportsScreen />
    </OperationsScreens>
  );
}
