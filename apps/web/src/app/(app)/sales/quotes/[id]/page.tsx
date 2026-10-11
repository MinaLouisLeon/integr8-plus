'use client';

import { QuoteScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One quote. */
export default function QuotePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <QuoteScreen key={id} quoteId={id} />
    </OperationsScreens>
  );
}
