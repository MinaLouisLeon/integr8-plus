'use client';

import { ExpenseCategoriesScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** What expenses may be claimed for. */
export default function ExpenseCategoriesPage() {
  return (
    <OperationsScreens>
      <ExpenseCategoriesScreen />
    </OperationsScreens>
  );
}
