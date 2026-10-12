'use client';

import { JournalScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One journal. */
export default function JournalPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <JournalScreen key={id} journalId={id} />
    </OperationsScreens>
  );
}
