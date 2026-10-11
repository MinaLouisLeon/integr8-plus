'use client';

import { LeadConvertScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** Converting a lead into a customer. */
export default function LeadConvertPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <LeadConvertScreen key={id} leadId={id} />
    </OperationsScreens>
  );
}
