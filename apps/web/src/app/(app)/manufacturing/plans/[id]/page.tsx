'use client';

import { MaterialPlanScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One planning run and its suggestions. */
export default function MaterialPlanPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <MaterialPlanScreen key={id} planId={id} />
    </OperationsScreens>
  );
}
