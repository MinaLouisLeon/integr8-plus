'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { MarketingShell } from '~/components/marketing-shell';

/**
 * What the sign-up pages show when public sign-up is off.
 *
 * Somebody can still arrive here: a bookmark, an old email, a link on another
 * site. Rather than a form the API will refuse, they get the same answer the
 * API gives — companies are set up by Integr8 — and the two places to go next.
 */
export function SignupClosed() {
  const { t } = useTranslation();

  return (
    <MarketingShell>
      <div className="mx-auto flex max-w-md flex-col gap-4 py-12">
        <h1 className="text-2xl font-semibold text-content">{t('signUp.closed.title')}</h1>
        <p className="text-content-muted">{t('signUp.closed.body')}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/contact"
            className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            {t('signUp.closed.contact')}
          </Link>
          <Link href="/sign-in" className="text-sm text-accent hover:underline">
            {t('signUp.closed.signIn')}
          </Link>
        </div>
      </div>
    </MarketingShell>
  );
}
