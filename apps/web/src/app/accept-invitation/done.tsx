'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';

/**
 * The page's last step (P42): the password is set (or, for an address that
 * already signed in, the person has joined), and the way on is the company's
 * own desktop or phone app, from its download page. Nothing here signs in.
 */
export function InvitationDone({
  done,
}: {
  done: { email: string; existingAccount: boolean; company: { name: string; slug: string } | null };
}) {
  const { t } = useTranslation();
  const company = done.company?.name ?? '';
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-1" role="status">
        <h1 className="text-2xl font-semibold text-content">
          {done.existingAccount ? t('auth.accept.doneTitleExisting') : t('auth.accept.doneTitle')}
        </h1>
        <p className="text-sm text-content-muted">
          {done.existingAccount
            ? t('auth.accept.doneExisting', { email: done.email, company })
            : t('auth.accept.doneNew', { email: done.email, company })}
        </p>
        <p className="text-sm text-content-muted">{t('auth.accept.doneApps', { company })}</p>
      </div>
      <Link
        href={
          done.company === null
            ? '/download'
            : `/download?company=${encodeURIComponent(done.company.slug)}`
        }
        className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
      >
        {t('auth.accept.getTheApps', { company })}
      </Link>
    </main>
  );
}
