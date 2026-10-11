'use client';

import { ItemScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One item. */
export default function ItemPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <ItemScreen key={id} itemId={id} />
    </OperationsScreens>
  );
}
