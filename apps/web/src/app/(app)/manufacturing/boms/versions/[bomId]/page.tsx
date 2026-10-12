'use client';

import { BomVersionScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One version of a bill of materials, read-only. */
export default function BomVersionPage() {
  const { bomId } = useParams<{ bomId: string }>();
  return (
    <OperationsScreens>
      <BomVersionScreen key={bomId} bomId={bomId} />
    </OperationsScreens>
  );
}
