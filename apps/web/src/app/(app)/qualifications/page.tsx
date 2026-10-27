'use client';

import { QualificationsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/**
 * People's skills and certificates (P26). Expiry emails link here, so the
 * path stays `/qualifications`.
 */
export default function QualificationsPage() {
  return (
    <OperationsScreens>
      <QualificationsScreen />
    </OperationsScreens>
  );
}
