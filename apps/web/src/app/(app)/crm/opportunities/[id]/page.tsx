'use client';

import { OpportunityScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One opportunity. */
export default function OpportunityPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <OpportunityScreen key={id} opportunityId={id} />
    </OperationsScreens>
  );
}
