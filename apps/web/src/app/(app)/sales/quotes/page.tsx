'use client';

import { QuoteListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Quotes: what has been offered to whom, by status. */
export default function QuotesPage() {
  return (
    <OperationsScreens>
      <QuoteListScreen />
    </OperationsScreens>
  );
}
