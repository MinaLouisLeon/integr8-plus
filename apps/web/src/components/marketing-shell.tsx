'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { recordFunnelStep } from '~/lib/funnel';
import { getStartedHref, signupMode } from '~/lib/signup';

/**
 * The public surface's shell (P18).
 *
 * Separate from `AuthGuard` and `PlatformShell` because it guards nothing:
 * every page inside it is for somebody with no account, and running a session
 * check for a visitor reading the pricing page is work done to no purpose.
 *
 * It also records the funnel step for whichever page it wraps. Doing it here
 * rather than in each page means a new public page is instrumented by existing,
 * which is the only way instrumentation survives contact with a deadline.
 */
export function MarketingShell({
  children,
  step,
}: {
  children: ReactNode;
  /** Which funnel step this page is. Omitted for pages outside the funnel. */
  step?: 'landing.viewed' | 'features.viewed' | 'pricing.viewed' | 'signup.opened';
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (step !== undefined) {
      recordFunnelStep(step);
    }
  }, [step]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border-subtle">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <Link href="/" className="text-lg font-semibold text-content">
            {t('common.appName')}
          </Link>
          <div className="flex flex-1 items-center justify-end gap-4 text-sm">
            <Link href="/features" className="text-content-muted hover:text-content">
              {t('marketing.nav.features')}
            </Link>
            <Link href="/pricing" className="text-content-muted hover:text-content">
              {t('marketing.nav.pricing')}
            </Link>
            <Link href="/help" className="text-content-muted hover:text-content">
              {t('marketing.nav.help')}
            </Link>
            <Link href="/sign-in" className="text-content-muted hover:text-content">
              {t('marketing.nav.signIn')}
            </Link>
            <Link
              href={getStartedHref()}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover"
            >
              {signupMode() === 'open' ? t('marketing.nav.signUp') : t('marketing.nav.contact')}
            </Link>
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">{children}</main>

      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-4 px-6 py-6 text-sm text-content-muted">
          <span>{t('common.appName')}</span>
          <Link href="/pricing" className="hover:text-content">
            {t('marketing.nav.pricing')}
          </Link>
          <Link href="/help" className="hover:text-content">
            {t('marketing.nav.help')}
          </Link>
        </div>
      </footer>
    </div>
  );
}

/**
 * The one button every public page ends with.
 *
 * With public sign-up open it starts a trial; with it off — the default, since
 * Integr8 sets companies up — it goes to the contact page. One component, so
 * no page can keep offering a form the API refuses.
 */
export function GetStartedLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  const open = signupMode() === 'open';

  return (
    <Link
      href={getStartedHref()}
      className={
        className ??
        'inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-hover'
      }
    >
      {open ? t('marketing.hero.cta') : t('marketing.hero.ctaClosed')}
    </Link>
  );
}
