'use client';

import { UnpostedListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Documents waiting to be posted to the ledger. */
export default function UnpostedPage() {
  return (
    <OperationsScreens>
      <UnpostedListScreen />
    </OperationsScreens>
  );
}
