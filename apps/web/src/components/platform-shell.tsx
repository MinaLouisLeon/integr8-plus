'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, ErrorState, LoadingState } from '~/components/ui';
import { ensurePlatformToken, signOutOfPlatform } from '~/lib/platform-session';

/**
 * The dashboard's shell and its guard (P15).
 *
 * The guard is the same idea as `AuthGuard` and deliberately not the same
 * component: it exchanges the *platform* cookie, and it sends a stranger to the
 * platform sign-in rather than the customer one. Sharing one guard with a
 * parameter would put the two sessions one wrong argument apart.
 *
 * The bar across the top is permanent, unlike the customer app's grid of cards,
 * because somebody running the business moves between these screens constantly
 * and a dashboard you have to go back to is a dashboard nobody uses.
 */

const LINKS = [
  { href: '/platform', key: 'companies' },
  { href: '/platform/funnel', key: 'funnel' },
  { href: '/platform/storage', key: 'storage' },
  { href: '/platform/plans', key: 'plans' },
  { href: '/platform/audit', key: 'audit' },
  { href: '/platform/flags', key: 'flags' },
  { href: '/platform/announcements', key: 'announcements' },
  { href: '/platform/templates', key: 'templates' },
  { href: '/platform/releases', key: 'releases' },
] as const;

export function PlatformShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<'checking' | 'signed-in' | 'failed'>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let token: string | null;
      try {
        token = await ensurePlatformToken();
      } catch {
        // Unreachable, not signed out. See `AuthGuard` for why this is an
        // error with a retry rather than a redirect or an endless spinner.
        if (!cancelled) {
          setState('failed');
        }
        return;
      }
      if (cancelled) {
        return;
      }
      if (token === null) {
        router.replace('/platform/sign-in');
        return;
      }
      setState('signed-in');
    })();

    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  if (state === 'checking') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-6xl items-center justify-center px-6">
        <LoadingState label={t('common.loading')} />
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-6xl items-center justify-center px-6">
        <ErrorState
          onRetry={() => {
            setState('checking');
            setAttempt((current) => current + 1);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle pb-4">
        <nav aria-label={t('platform.title')} className="flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            // `/platform` would otherwise look current on every page under it.
            const current =
              link.href === '/platform' ? pathname === link.href : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={current ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  current
                    ? 'bg-accent text-on-accent'
                    : 'text-content-muted hover:bg-surface-muted hover:text-content'
                }`}
              >
                {t(`platform.nav.${link.key}`)}
              </Link>
            );
          })}
        </nav>

        <Button
          variant="secondary"
          onClick={() => {
            void (async () => {
              await signOutOfPlatform();
              router.replace('/platform/sign-in');
            })();
          }}
        >
          {t('platform.nav.signOut')}
        </Button>
      </header>

      {children}
    </div>
  );
}
