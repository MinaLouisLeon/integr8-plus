'use client';

import { BomScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One item's bill of materials, by the item. */
export default function BomPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <BomScreen key={id} itemId={id} />
    </OperationsScreens>
  );
}
