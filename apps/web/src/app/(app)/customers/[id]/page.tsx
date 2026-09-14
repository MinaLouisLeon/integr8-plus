'use client';

import { CustomerScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One customer: contacts, sites and recent jobs. */
export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <CustomerScreen key={id} customerId={id} />
    </OperationsScreens>
  );
}
