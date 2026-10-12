'use client';

import { MyProfileScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The signed-in person's own employee profile. */
export default function MyProfilePage() {
  return (
    <OperationsScreens>
      <MyProfileScreen />
    </OperationsScreens>
  );
}
