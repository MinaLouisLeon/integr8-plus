'use client';

import { AssetScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One asset, with its history. */
export default function AssetPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <AssetScreen key={id} assetId={id} />
    </OperationsScreens>
  );
}
