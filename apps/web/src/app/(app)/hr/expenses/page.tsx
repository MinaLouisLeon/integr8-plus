'use client';

import { MyExpenseClaimsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The signed-in person's own expense claims (ADR-0010). */
export default function MyExpensesPage() {
  return (
    <OperationsScreens>
      <MyExpenseClaimsScreen />
    </OperationsScreens>
  );
}
