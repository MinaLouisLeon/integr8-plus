'use client';

import { ReorderScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** A location's reorder list, to draft purchase orders from. */
export default function ReorderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <ReorderScreen key={id} locationId={id} />
    </OperationsScreens>
  );
}
