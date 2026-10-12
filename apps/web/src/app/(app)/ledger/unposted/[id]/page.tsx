'use client';

import { UnpostedScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One document from the unposted list. */
export default function UnpostedItemPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <UnpostedScreen key={id} postingId={id} />
    </OperationsScreens>
  );
}
