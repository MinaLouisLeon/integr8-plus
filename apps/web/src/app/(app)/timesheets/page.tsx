'use client';

import { TimesheetsScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** Shifts and time on jobs, a week at a time. */
export default function TimesheetsPage() {
  return (
    <OperationsScreens>
      <TimesheetsScreen />
    </OperationsScreens>
  );
}
