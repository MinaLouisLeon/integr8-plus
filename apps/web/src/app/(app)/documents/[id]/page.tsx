'use client';

import { DocumentScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One PDF document: its fields, its file and its link. */
export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <DocumentScreen key={id} documentId={id} />
    </OperationsScreens>
  );
}
