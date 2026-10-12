'use client';

import { ExpenseClaimsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Everybody's expense claims, for those who approve them (ADR-0010). */
export default function ExpenseClaimsPage() {
  return (
    <OperationsScreens>
      <ExpenseClaimsScreen />
    </OperationsScreens>
  );
}
