'use client';

import { FillStartScreen } from '@integr8/form-renderer-dom/screens';
import { FormScreens } from '~/components/form-screens';

/** Forms this person may fill in, and the ones they left unfinished on any device. */
export default function FillPage() {
  return (
    <FormScreens>
      <FillStartScreen />
    </FormScreens>
  );
}
