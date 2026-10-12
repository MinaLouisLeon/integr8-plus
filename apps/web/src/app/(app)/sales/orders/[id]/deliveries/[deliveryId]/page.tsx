'use client';

import { DeliveryNoteScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** A delivery note, to print or save as a PDF from the browser. */
export default function DeliveryNotePage() {
  const { id, deliveryId } = useParams<{ id: string; deliveryId: string }>();
  return (
    <OperationsScreens>
      <DeliveryNoteScreen key={deliveryId} orderId={id} deliveryId={deliveryId} />
    </OperationsScreens>
  );
}
