'use client';

import { CompanyRolesScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/**
 * The company's own roles (ADR-0013), beside the people who hold them: under
 * `/settings/people`, so the menu marks People and the top bar leads back.
 */
export default function CompanyRolesPage() {
  return (
    <OperationsScreens>
      <CompanyRolesScreen peoplePath="/settings/people" />
    </OperationsScreens>
  );
}
