'use client';

import { SiteScreen } from '@integr8/operations-dom';
import { useParams } from 'next/navigation';
import { OperationsScreens } from '~/components/operations-screens';

/** One site: access notes, location, contact and jobs. */
export default function SitePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <OperationsScreens>
      <SiteScreen key={id} siteId={id} />
    </OperationsScreens>
  );
}
