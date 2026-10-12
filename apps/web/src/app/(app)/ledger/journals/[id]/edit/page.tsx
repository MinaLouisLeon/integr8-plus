'use client';

import { JournalEditorScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** A draft journal, rewritten. */
export default function EditJournalPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <JournalEditorScreen key={id} journalId={id} />
    </OperationsScreens>
  );
}
