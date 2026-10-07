'use client';

import { useTranslation } from '@integr8/i18n';
import { GetStartedLink, MarketingShell } from '~/components/marketing-shell';
import { signupMode } from '~/lib/signup';

/**
 * The landing page (P18).
 *
 * Three claims and a button. Every claim is something the product actually
 * does — offline capture, versioned forms of your own, evidence attached to the
 * job — so if a line here stops being true it is a bug in one or the other,
 * not marketing licence.
 *
 * No superlatives and no invented statistics. The people this is sold to have
 * been promised a great deal by software before, and the plan is explicit that
 * the guided first run matters more than this page does.
 */
export default function HomePage() {
  const { t } = useTranslation();

  const points = [
    { key: 'offline', title: 'offlineTitle', body: 'offlineBody' },
    { key: 'forms', title: 'formsTitle', body: 'formsBody' },
    { key: 'evidence', title: 'evidenceTitle', body: 'evidenceBody' },
  ] as const;

  return (
    <MarketingShell step="landing.viewed">
      <section className="flex flex-col gap-6 py-8">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-content sm:text-5xl">
          {t('marketing.hero.title')}
        </h1>
        <p className="max-w-prose text-lg text-content-muted">{t('marketing.hero.subtitle')}</p>
        <div className="flex flex-wrap items-center gap-4">
          <GetStartedLink />
          <span className="text-sm text-content-muted">
            {signupMode() === 'open' ? t('marketing.hero.note') : t('marketing.hero.noteClosed')}
          </span>
        </div>
      </section>

      <section className="grid gap-6 py-8 sm:grid-cols-3">
        {points.map((point) => (
          <div key={point.key} className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-content">
              {t(`marketing.points.${point.title}`)}
            </h2>
            <p className="text-sm text-content-muted">{t(`marketing.points.${point.body}`)}</p>
          </div>
        ))}
      </section>
    </MarketingShell>
  );
}
