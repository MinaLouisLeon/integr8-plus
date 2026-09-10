'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';

/**
 * The marketing shell.
 *
 * Deliberately thin: P18 builds the real marketing site and self-serve signup.
 * What it establishes now is that the public surface and the signed-in surface
 * are separate route groups with separate layouts, so the dashboard's guard
 * never has to run for a visitor reading the home page.
 */
export default function HomePage() {
  const { t } = useTranslation();

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 px-6">
      <h1 className="text-4xl font-bold tracking-tight text-content">{t('common.appName')}</h1>
      <p className="max-w-prose text-lg text-content-muted">{t('auth.signInSubtitle')}</p>
      <div>
        <Link
          href="/sign-in"
          className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t('auth.signIn')}
        </Link>
      </div>
    </main>
  );
}
