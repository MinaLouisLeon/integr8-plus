'use client';

import { StockCountScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** A stock count. */
export default function StockCountPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <StockCountScreen key={id} countId={id} />
    </OperationsScreens>
  );
}
