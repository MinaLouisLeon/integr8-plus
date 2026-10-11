'use client';

import { SupplierScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One supplier. */
export default function SupplierPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <SupplierScreen key={id} supplierId={id} />
    </OperationsScreens>
  );
}
