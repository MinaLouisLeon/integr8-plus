'use client';

import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ErrorState, LoadingState } from '~/components/ui';
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
  const [state, setState] = useState<'checking' | 'signed-in' | 'failed'>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let token: string | null;
      try {
        token = await ensureAccessToken();
      } catch {
        // The API is unreachable, or the network is. Not "signed out" — the
        // cookie may be perfectly good — so not a redirect, and not a spinner
        // that never ends either: something to read, and a button.
        if (!cancelled) {
          setState('failed');
        }
        return;
      }
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
  }, [router, attempt]);

  if (state === 'checking') {
    return <LoadingState label={t('common.loading')} />;
  }

  if (state === 'failed') {
    return (
      <ErrorState
        onRetry={() => {
          setState('checking');
          setAttempt((current) => current + 1);
        }}
      />
    );
  }

  return <>{children}</>;
}
