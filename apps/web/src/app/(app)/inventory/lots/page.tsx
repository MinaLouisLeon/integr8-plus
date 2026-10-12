'use client';

import { LotLookupScreen } from '@integr8/operations-dom';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { OperationsScreens } from '~/components/operations-screens';

/** The serial lookup: a serial number or batch, by the start of its code. */
export default function LotLookupPage() {
  return (
    <OperationsScreens>
      <Suspense>
        <LotLookup />
      </Suspense>
    </OperationsScreens>
  );
}

/** `?code=` opens the lookup with that code already searched, as a scanner's link does. */
function LotLookup() {
  const code = useSearchParams().get('code') ?? '';
  return <LotLookupScreen key={code} initialCode={code} />;
}
