'use client';

import { ItemListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The catalogue. */
export default function ItemsPage() {
  return (
    <OperationsScreens>
      <ItemListScreen />
    </OperationsScreens>
  );
}
