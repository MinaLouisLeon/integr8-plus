'use client';

import { SubmissionScreen } from '@integr8/form-renderer-dom/screens';
import { useParams } from 'next/navigation';
import { FormScreens } from '~/components/form-screens';

/** One submission: filled in, read back or corrected, with its history. */
export default function SubmissionPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <FormScreens>
      <SubmissionScreen key={id} submissionId={id} />
    </FormScreens>
  );
}
