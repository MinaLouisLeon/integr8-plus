'use client';

import { AssemblyOrderListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Assembly and disassembly orders. */
export default function AssemblyOrdersPage() {
  return (
    <OperationsScreens>
      <AssemblyOrderListScreen />
    </OperationsScreens>
  );
}
