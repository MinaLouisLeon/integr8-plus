'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { MarketingShell } from '~/components/marketing-shell';
import { contactEmail } from '~/lib/signup';

/**
 * How a company gets started (P18, revised).
 *
 * There is no self-serve sign-up: Integr8 sets each company up, builds its
 * forms and job types with it, and hands over the apps. So the page every
 * "get started" button leads to says that plainly and gives one address.
 */
export default function ContactPage() {
  const { t } = useTranslation();
  const email = contactEmail();

  return (
    <MarketingShell>
      <div className="mx-auto flex max-w-xl flex-col gap-6 py-12">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold text-content">{t('marketing.contact.title')}</h1>
          <p className="text-lg text-content-muted">{t('marketing.contact.subtitle')}</p>
        </div>

        <ol className="flex list-decimal flex-col gap-2 ps-5 text-content-muted">
          <li>{t('marketing.contact.step1')}</li>
          <li>{t('marketing.contact.step2')}</li>
          <li>{t('marketing.contact.step3')}</li>
        </ol>

        <div className="flex flex-wrap items-center gap-4">
          <a
            href={`mailto:${email}`}
            className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            {t('marketing.contact.email')}
          </a>
          <span className="text-sm text-content-muted">{email}</span>
        </div>

        <p className="text-sm text-content-muted">
          {t('marketing.contact.haveAccount')}{' '}
          <Link href="/sign-in" className="text-accent hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </div>
    </MarketingShell>
  );
}
