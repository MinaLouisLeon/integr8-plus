'use client';

import { EtaDocumentScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One ETA document: its state, what the ETA said, and the next step. */
export default function EtaDocumentPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <EtaDocumentScreen key={id} documentId={id} />
    </OperationsScreens>
  );
}
