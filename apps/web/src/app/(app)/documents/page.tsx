'use client';

import { DocumentListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The company's PDF documents (docs/documents). */
export default function DocumentsPage() {
  return (
    <OperationsScreens>
      <DocumentListScreen />
    </OperationsScreens>
  );
}
