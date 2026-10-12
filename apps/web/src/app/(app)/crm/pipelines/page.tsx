'use client';

import { PipelineListScreen } from '@integr8/operations-dom';
import { OperationsScreens } from '~/components/operations-screens';

/** The CRM's pipelines, kept by owners and admins. */
export default function PipelinesPage() {
  return (
    <OperationsScreens>
      <PipelineListScreen />
    </OperationsScreens>
  );
}
