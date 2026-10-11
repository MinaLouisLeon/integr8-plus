'use client';

import { AssetListScreen } from '@integr8/operations-dom';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { OperationsScreens } from '~/components/operations-screens';

/** The asset register: the machines the company services. */
export default function AssetsPage() {
  return (
    <OperationsScreens>
      <Suspense>
        <Assets />
      </Suspense>
    </OperationsScreens>
  );
}

/** `?warranty=expiring` opens the register filtered, as the dashboard's list does. */
function Assets() {
  const filter = useSearchParams().get('warranty');
  const warranty = filter === 'expiring' || filter === 'expired' ? filter : '';
  return <AssetListScreen key={warranty} initialWarranty={warranty} />;
}
