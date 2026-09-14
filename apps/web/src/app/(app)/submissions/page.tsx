'use client';

import { SubmissionListScreen } from '@integr8/form-renderer-dom/screens';
import { FormScreens } from '~/components/form-screens';

/** Finding submissions, and exporting them. */
export default function SubmissionsPage() {
  return (
    <FormScreens>
      <SubmissionListScreen />
    </FormScreens>
  );
}
