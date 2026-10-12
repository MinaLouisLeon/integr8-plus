'use client';

import { JournalListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Journals, posted and drafted. */
export default function JournalsPage() {
  return (
    <OperationsScreens>
      <JournalListScreen />
    </OperationsScreens>
  );
}
