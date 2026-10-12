'use client';

import { PayRunScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One month's pay run. */
export default function PayRunPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <PayRunScreen key={id} runId={id} />
    </OperationsScreens>
  );
}
