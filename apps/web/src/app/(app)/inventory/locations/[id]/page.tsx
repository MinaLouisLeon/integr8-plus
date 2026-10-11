'use client';

import { LocationScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One stock location. */
export default function StockLocationPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <LocationScreen key={id} locationId={id} />
    </OperationsScreens>
  );
}
