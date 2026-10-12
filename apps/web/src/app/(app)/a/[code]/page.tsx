'use client';

import { AssetTagOpener } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/**
 * Where a printed asset tag's QR code leads. Inside the signed-in area, so a
 * visitor who is not signed in is sent to sign in and brought back here.
 */
export default function AssetTagPage() {
  const { code } = useParams<{ code: string }>();
  return (
    <OperationsScreens>
      <AssetTagOpener key={code} code={decodeURIComponent(code)} />
    </OperationsScreens>
  );
}
