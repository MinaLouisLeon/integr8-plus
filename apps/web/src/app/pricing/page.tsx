'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MarketingShell, PageIntro, pillClass } from '~/components/marketing-shell';
import { Magnetic } from '~/components/site/motion';
import { getStartedHref, signupMode } from '~/lib/signup';
import { ErrorState, LoadingState } from '~/components/ui';
import { formatBytes } from '~/lib/platform-format';
import { planLabel } from '~/lib/plans';
import { apiClient } from '~/lib/session';

/**
 * Pricing (P18).
 *
 * **Every number on this page is read from the API, not written in the copy.**
 * That is the exit criterion — *every plan limit shown on the pricing page
 * matches what the entitlement service enforces* — and reading
 * `plan_allowances` through `GET /v1/plans` is the only way to guarantee it.
 * Numbers typed into marketing copy are a second source of truth, and the two
 * disagree the first time somebody edits a plan from the dashboard.
 *
 * A plan with no price at the provider is shown as "talk to us" rather than
 * hidden or offered: hiding it makes the page lie about what exists, and
 * offering it sends somebody to a checkout that refuses them.
 *
 * Worn in the Integr8 Media look (Low 3): what every plan includes and which
 * modules are switched on per company are words, in `site.pricing.*`; the
 * numbers stay the API's.
 */

const INCLUDED = ['apps', 'offline', 'languages', 'setup', 'export'] as const;
const PLAN_GLOW = [
  'var(--site-violet)',
  'var(--site-lime)',
  'var(--site-cyan)',
  'var(--site-pink)',
];

export default function PricingPage() {
  const { t, i18n } = useTranslation();

  const plans = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/plans');
      return data;
    },
  });

  return (
    <MarketingShell step="pricing.viewed">
      <PageIntro
        eyebrow={t('site.pricing.eyebrow')}
        title={t('site.pricing.title')}
        gradient={t('site.pricing.titleGradient')}
        subtitle={t('marketing.pricing.subtitle')}
      >
        <p className="mt-3 max-w-2xl text-sm text-site-muted">{t('marketing.pricing.honest')}</p>
      </PageIntro>

      {plans.isPending ? (
        <LoadingState />
      ) : plans.isError || plans.data === undefined ? (
        <ErrorState
          requestId={plans.error instanceof ApiRequestError ? plans.error.requestId : undefined}
          onRetry={() => void plans.refetch()}
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {plans.data.items.map((plan, index) => (
            <article
              key={plan.plan}
              className="relative flex flex-col gap-5 overflow-hidden rounded-3xl border border-site-line bg-site-soft p-7"
            >
              <div
                aria-hidden="true"
                className="site-glow size-40 opacity-20"
                style={{
                  background: PLAN_GLOW[index % PLAN_GLOW.length],
                  insetBlockStart: '-3rem',
                  insetInlineEnd: '-3rem',
                }}
              />
              <h2 className="relative font-mono text-xs tracking-[0.2em] text-site-muted uppercase rtl:tracking-normal">
                {planLabel(t, plan.plan)}
              </h2>

              <p className="relative font-display text-3xl font-semibold text-site-fg">
                {plan.priceCents === null ? (
                  t('marketing.pricing.free')
                ) : (
                  <>
                    {new Intl.NumberFormat(i18n.language, {
                      style: 'currency',
                      currency: plan.currency ?? 'GBP',
                      maximumFractionDigits: 0,
                    }).format(plan.priceCents / 100)}
                    <span className="font-sans text-sm font-normal text-site-muted">
                      {' '}
                      {t('marketing.pricing.perMonth')}
                    </span>
                  </>
                )}
              </p>

              <ul className="relative flex flex-1 flex-col gap-2 border-t border-site-line pt-5 text-sm text-site-muted">
                <li>
                  {plan.seats === null
                    ? t('marketing.pricing.seatsUncapped')
                    : t('marketing.pricing.seats', { count: plan.seats })}
                </li>
                <li>
                  {plan.submissionsPerMonth === null
                    ? t('marketing.pricing.submissionsUncapped')
                    : t('marketing.pricing.submissions', { count: plan.submissionsPerMonth })}
                </li>
                <li>
                  {plan.storageBytes === null
                    ? t('marketing.pricing.storageUncapped')
                    : t('marketing.pricing.storage', { amount: formatBytes(plan.storageBytes) })}
                </li>
                <li>
                  {plan.retentionDays === null
                    ? t('marketing.pricing.retentionForever')
                    : t('marketing.pricing.retention', { count: plan.retentionDays })}
                </li>
              </ul>

              {plan.purchasable ? (
                <Magnetic className="relative">
                  <Link
                    href={getStartedHref()}
                    className={pillClass(index === 1 ? 'lime' : 'outline', 'sm')}
                  >
                    {signupMode() === 'open'
                      ? t('marketing.pricing.choose', { plan: plan.plan })
                      : t('marketing.pricing.contact')}
                  </Link>
                </Magnetic>
              ) : (
                // Not hidden and not offered. Hiding it would make the page lie
                // about what exists; offering it would send somebody to a
                // checkout that refuses them.
                <span className="relative text-sm text-site-muted">
                  {t('marketing.pricing.notPurchasable')}
                </span>
              )}
            </article>
          ))}
        </div>
      )}

      <section className="mt-16 grid gap-10 rounded-3xl border border-site-line p-7 sm:p-10 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 className="font-display text-2xl font-semibold">{t('site.pricing.included')}</h2>
          <ul className="mt-6 flex flex-col gap-3">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-3 text-site-fg">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-lime" />
                {t(`site.pricing.includedItems.${item}`)}
              </li>
            ))}
          </ul>
        </div>
        <p className="self-end text-sm leading-relaxed text-site-muted">
          {t('site.pricing.modulesNote')}
        </p>
      </section>
    </MarketingShell>
  );
}
