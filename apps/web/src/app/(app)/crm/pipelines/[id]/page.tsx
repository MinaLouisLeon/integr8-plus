'use client';

import { PipelineScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One pipeline and its stages. */
export default function PipelinePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <PipelineScreen key={id} pipelineId={id} />
    </OperationsScreens>
  );
}
