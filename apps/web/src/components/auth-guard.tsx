'use client';

import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LoadingState } from '~/components/ui';
import { ensureAccessToken } from '~/lib/session';

/**
 * Keeps signed-out visitors out of the signed-in surface.
 *
 * A client component, and a small one, so the layout around it can stay on the
 * server and render `dir` and `data-theme` into the first byte.
 *
 * The check is a token exchange rather than a flag: the httpOnly cookie is the
 * only durable evidence a session exists, and only the server can read it. That
 * costs one request on first load, and is the price of the refresh token never
 * being reachable from JavaScript.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [state, setState] = useState<'checking' | 'signed-in'>('checking');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const token = await ensureAccessToken();
      if (cancelled) {
        return;
      }

      if (token === null) {
        router.replace('/sign-in');
        return;
      }

      setState('signed-in');
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state === 'checking') {
    return <LoadingState label={t('common.loading')} />;
  }

  return <>{children}</>;
}
