'use client';

import { PayrollRulesScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The payroll rule sets: tax bands, social insurance and the Martyrs' Fund (ADR-0010). */
export default function PayrollRulesPage() {
  return (
    <OperationsScreens>
      <PayrollRulesScreen />
    </OperationsScreens>
  );
}
