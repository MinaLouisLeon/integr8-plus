'use client';

import { SubmissionListScreen } from '@integr8/form-renderer-dom/screens';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { FormScreens } from '~/components/form-screens';

/** Finding submissions, and exporting them. */
export default function SubmissionsPage() {
  return (
    <FormScreens>
      <Suspense>
        <Submissions />
      </Suspense>
    </FormScreens>
  );
}

/** `?workOrderId=` opens the list at one job's submissions, as a job's link does. */
function Submissions() {
  const workOrderId = useSearchParams().get('workOrderId');
  return (
    <SubmissionListScreen
      key={workOrderId ?? ''}
      initialFilters={workOrderId === null ? {} : { workOrderId }}
    />
  );
}
