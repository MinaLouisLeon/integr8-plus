'use client';

import { JournalEditorScreen } from '@integr8/operations-dom';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { OperationsScreens } from '~/components/operations-screens';

/** A new manual journal, or with `?kind=opening` the opening balances. */
export default function NewJournalPage() {
  return (
    <OperationsScreens>
      <Suspense>
        <NewJournal />
      </Suspense>
    </OperationsScreens>
  );
}

function NewJournal() {
  const opening = useSearchParams().get('kind') === 'opening';
  return <JournalEditorScreen key={String(opening)} opening={opening} />;
}
