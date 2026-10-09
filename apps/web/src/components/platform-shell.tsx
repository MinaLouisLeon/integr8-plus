'use client';

import { PLATFORM_NAV_SECTIONS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { DashboardShell, type ShellNavGroup } from '~/components/dashboard-shell';
import { LocaleSelect } from '~/components/locale-select';
import { SignOutIcon } from '~/components/nav-icon';
import { ErrorState, LoadingState } from '~/components/ui';
import { PLATFORM_NAV_ALIASES, PLATFORM_NAV_PATHS } from '~/lib/navigation';
import { ensurePlatformToken, signOutOfPlatform } from '~/lib/platform-session';

/**
 * The platform dashboard's shell and its guard (P15).
 *
 * The guard is the same idea as `AuthGuard` and deliberately not the same
 * component: it exchanges the *platform* cookie, and it sends a stranger to the
 * platform sign-in rather than the customer one. Sharing one guard with a
 * parameter would put the two sessions one wrong argument apart.
 *
 * The shell is the customer app's, drawn with the platform's sections: one
 * group, the product's own mark, and no company colours — this is Integr8's
 * screen, not a customer's.
 */
export function PlatformShell({
  initialCollapsed,
  children,
}: {
  initialCollapsed: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const router = useRouter();
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

  const groups: ShellNavGroup[] = [
    {
      key: 'platform',
      items: PLATFORM_NAV_SECTIONS.map((section) => {
        const aliases = PLATFORM_NAV_ALIASES[section.key];
        return {
          key: section.key,
          href: PLATFORM_NAV_PATHS[section.key],
          // `/platform` would otherwise look current on every page under it.
          ...(section.key === 'companies' ? { exact: true } : {}),
          ...(aliases === undefined ? {} : { aliases }),
          label: t(`platform.nav.${section.key}`),
          icon: section.icon,
        };
      }),
    },
  ];

  return (
    <DashboardShell
      navLabel={t('platform.title')}
      groups={groups}
      initialCollapsed={initialCollapsed}
      fallbackTitle={t('platform.title')}
      brand={(collapsed) => (
        <span className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-base font-semibold text-on-accent"
          >
            {t('common.appName').slice(0, 1)}
          </span>
          {collapsed ? (
            <span className="sr-only">{t('platform.title')}</span>
          ) : (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold text-shell-text">
                {t('common.appName')}
              </span>
              <span className="truncate text-xs text-shell-text-muted">{t('platform.title')}</span>
            </span>
          )}
        </span>
      )}
      footer={(collapsed) => (
        <>
          <LocaleSelect compact={collapsed} />
          <button
            type="button"
            title={collapsed ? t('platform.nav.signOut') : undefined}
            onClick={() => {
              void (async () => {
                await signOutOfPlatform();
                router.replace('/platform/sign-in');
              })();
            }}
            className={[
              'flex items-center gap-3 rounded-md py-2 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text',
              collapsed ? 'justify-center px-0' : 'px-3',
            ].join(' ')}
          >
            <SignOutIcon className="size-5 shrink-0 rtl:rotate-180" />
            {collapsed ? (
              <span className="sr-only">{t('platform.nav.signOut')}</span>
            ) : (
              t('platform.nav.signOut')
            )}
          </button>
        </>
      )}
    >
      {children}
    </DashboardShell>
  );
}
