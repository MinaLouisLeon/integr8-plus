'use client';

import { AssetListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The asset register: the machines the company services. */
export default function AssetsPage() {
  return (
    <OperationsScreens>
      <AssetListScreen />
    </OperationsScreens>
  );
}
