'use client';

import { EtaScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Egyptian e-invoicing (docs/e-invoicing): ETA documents, settings and codes. */
export default function EInvoicingPage() {
  return (
    <OperationsScreens>
      <EtaScreen />
    </OperationsScreens>
  );
}
