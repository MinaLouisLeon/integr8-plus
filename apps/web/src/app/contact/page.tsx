'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { MarketingShell, PageIntro, pillClass } from '~/components/marketing-shell';
import { Magnetic } from '~/components/site/motion';
import { contactEmail } from '~/lib/signup';

/**
 * How a company gets started (P18, revised; Integr8 Media look, Low 3).
 *
 * There is no self-serve sign-up: Integr8 sets each company up, builds its
 * forms and job types with it, and hands over the apps. So the page every
 * "get started" button leads to says that plainly and gives one address.
 */
const STEPS = [
  { key: 'step1', colour: 'var(--site-violet)' },
  { key: 'step2', colour: 'var(--site-cyan)' },
  { key: 'step3', colour: 'var(--site-lime)' },
] as const;

export default function ContactPage() {
  const { t } = useTranslation();
  const email = contactEmail();

  return (
    <MarketingShell>
      <PageIntro
        eyebrow={t('site.contact.eyebrow')}
        title={t('marketing.contact.title')}
        subtitle={t('marketing.contact.subtitle')}
      />

      <ol className="grid gap-5 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li
            key={step.key}
            className="flex flex-col gap-6 rounded-3xl border border-site-line bg-site-soft p-7"
          >
            <span
              aria-hidden="true"
              className="text-outline font-display text-6xl leading-none font-extrabold"
            >
              {`0${String(index + 1)}`}
            </span>
            <p className="text-site-fg">{t(`marketing.contact.${step.key}`)}</p>
            <span
              aria-hidden="true"
              className="mt-auto h-0.5 w-12 rounded-full"
              style={{ background: step.colour }}
            />
          </li>
        ))}
      </ol>

      <div className="mt-14 flex flex-col items-start gap-6 rounded-3xl border border-site-line p-7 sm:p-10">
        <div className="flex flex-wrap items-center gap-4">
          <Magnetic>
            <a href={`mailto:${email}`} className={pillClass('lime')}>
              {t('marketing.contact.email')}
              <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
                →
              </span>
            </a>
          </Magnetic>
          <a
            href={`mailto:${email}`}
            dir="ltr"
            className="font-mono text-sm text-site-fg underline decoration-site-line underline-offset-4 hover:text-lime"
          >
            {email}
          </a>
        </div>
        <p className="text-sm text-site-muted">
          {t('marketing.contact.haveAccount')}{' '}
          <Link href="/sign-in" className="text-lime hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </div>
    </MarketingShell>
  );
}
