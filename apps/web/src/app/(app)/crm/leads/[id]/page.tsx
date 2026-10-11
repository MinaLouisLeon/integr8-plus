'use client';

import { LeadScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One lead. */
export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <LeadScreen key={id} leadId={id} />
    </OperationsScreens>
  );
}
