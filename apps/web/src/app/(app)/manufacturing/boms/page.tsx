'use client';

import { BomListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Bills of materials. */
export default function BomsPage() {
  return (
    <OperationsScreens>
      <BomListScreen />
    </OperationsScreens>
  );
}
