'use client';

import { LotScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One serial number or batch: where it is now, and where it has been. */
export default function LotPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <LotScreen key={id} lotId={id} />
    </OperationsScreens>
  );
}
