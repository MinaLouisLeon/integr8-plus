'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { GetStartedLink, MarketingShell, pillClass } from '~/components/marketing-shell';
import { Eyebrow, Magnetic, RevealText, ScrambleText } from '~/components/site/motion';
import { contactEmail, signupMode } from '~/lib/signup';
import { HIGHLIGHTS } from '~/lib/site-content';

/**
 * The landing page (P18), in the Integr8 Media look (Low 3).
 *
 * What the product is, who uses which app, how a company gets started, and a
 * handful of the features, each one something the product does today (the
 * words are in `@integr8/i18n`'s `site.*` block, written from the README and
 * the shipped modules). No superlatives and no invented statistics: the
 * people this is sold to have been promised a great deal by software before.
 */

const MODULES = [
  'workOrders',
  'schedule',
  'forms',
  'crm',
  'sales',
  'inventory',
  'purchasing',
  'assets',
  'finance',
  'ledger',
  'hr',
  'payroll',
  'manufacturing',
  'documents',
  'eInvoicing',
] as const;

const APPS = [
  { key: 'office', accent: 'var(--site-cyan)' },
  { key: 'field', accent: 'var(--site-lime)' },
  { key: 'integr8', accent: 'var(--site-pink)' },
] as const;

const STEPS = [
  { key: 'one', colour: 'var(--site-violet)' },
  { key: 'two', colour: 'var(--site-pink)' },
  { key: 'three', colour: 'var(--site-cyan)' },
  { key: 'four', colour: 'var(--site-lime)' },
] as const;

export default function HomePage() {
  const { t } = useTranslation();
  const email = contactEmail();

  return (
    <MarketingShell step="landing.viewed" width="full">
      {/* The opening */}
      <section className="relative isolate overflow-hidden px-4 pt-32 pb-20 sm:px-8 sm:pt-40 sm:pb-28">
        <div aria-hidden="true" className="site-grid absolute inset-0 -z-10" />
        <div
          aria-hidden="true"
          className="site-glow -z-10 size-[28rem] bg-violet opacity-35"
          style={{ insetBlockStart: '-6rem', insetInlineStart: '-8rem' }}
        />
        <div
          aria-hidden="true"
          className="site-glow -z-10 size-[24rem] bg-cyan opacity-20"
          style={{ insetBlockEnd: '-6rem', insetInlineEnd: '-6rem' }}
        />
        <span
          aria-hidden="true"
          className="site-eight pointer-events-none absolute -z-10 hidden font-display text-[26rem] leading-none font-extrabold select-none lg:block"
          style={{ insetBlockStart: '7rem', insetInlineEnd: '4%' }}
        >
          8
        </span>

        <div className="mx-auto max-w-6xl">
          <div className="mb-10 flex flex-wrap justify-between gap-4 font-mono text-[11px] tracking-[0.3em] text-site-muted uppercase rtl:tracking-normal">
            <span>{t('site.home.metaStart')}</span>
            <span className="hidden sm:inline">{t('site.home.metaEnd')}</span>
          </div>

          <Eyebrow>{t('site.home.eyebrow')}</Eyebrow>
          <h1 className="max-w-5xl font-display text-[2.6rem] leading-[1.05] font-bold sm:text-7xl lg:text-8xl">
            <RevealText text={t('site.home.titleLine1')} />
            <br />
            <span className="text-gradient">
              <RevealText text={t('site.home.titleGradient')} delay={0.2} />
            </span>
          </h1>

          <div className="mt-10 grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-end">
            <p className="max-w-2xl text-base leading-relaxed text-site-muted sm:text-lg">
              {t('site.home.subtitle')}
            </p>
            <div className="flex flex-col items-start gap-4 lg:items-end">
              <div className="flex flex-wrap gap-3">
                <Magnetic>
                  <GetStartedLink className={pillClass('white')} />
                </Magnetic>
                <Magnetic>
                  <Link href="/features" className={pillClass('outline')}>
                    {t('site.home.secondaryCta')}
                  </Link>
                </Magnetic>
              </div>
              <p className="text-sm text-site-muted">
                {signupMode() === 'open'
                  ? t('marketing.hero.note')
                  : t('marketing.hero.noteClosed')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What is inside: the modules, moving along a strip */}
      <section aria-labelledby="modules" className="border-y border-site-line py-6">
        <h2 id="modules" className="sr-only">
          {t('site.home.modulesLabel')}
        </h2>
        <div className="overflow-hidden">
          <div className="site-marquee">
            {[0, 1].map((copy) => (
              <ul
                key={copy}
                aria-hidden={copy === 1 ? true : undefined}
                className="flex shrink-0 items-center"
              >
                {MODULES.map((module) => (
                  <li
                    key={module}
                    className="flex items-center gap-6 pe-6 font-display text-xl font-semibold whitespace-nowrap text-site-fg/80 sm:text-2xl"
                  >
                    {t(`site.home.modules.${module}`)}
                    <span aria-hidden="true" className="text-lime">
                      ✦
                    </span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
      </section>

      {/* Three apps, one company */}
      <section className="mx-auto max-w-6xl px-4 py-24 sm:px-8 sm:py-32">
        <Eyebrow>{t('site.home.appsEyebrow')}</Eyebrow>
        <h2 className="max-w-3xl font-display text-4xl leading-tight font-semibold sm:text-6xl">
          <RevealText text={t('site.home.appsTitle')} />
          <br />
          <span className="text-outline">
            <RevealText text={t('site.home.appsTitleOutline')} delay={0.15} />
          </span>
        </h2>
        <p className="mt-6 max-w-xl text-site-muted">{t('site.home.appsSubtitle')}</p>

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {APPS.map((app, index) => (
            <article
              key={app.key}
              className="group relative overflow-hidden rounded-3xl border border-site-line bg-site-soft p-7 transition-colors duration-300 hover:border-white/20"
            >
              <div
                aria-hidden="true"
                className="site-glow size-56 opacity-10 transition-opacity duration-500 group-hover:opacity-30"
                style={{
                  background: app.accent,
                  insetBlockStart: '-5rem',
                  insetInlineEnd: '-5rem',
                }}
              />
              <div className="relative">
                <div className="mb-10 flex items-center justify-between font-mono text-xs text-site-muted">
                  <span>{`0${String(index + 1)}`}</span>
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-full border border-site-line text-base text-site-fg transition-transform duration-300 group-hover:rotate-45 rtl:-scale-x-100"
                  >
                    ↗
                  </span>
                </div>
                <h3 className="font-display text-2xl font-semibold">
                  <ScrambleText text={t(`site.home.apps.${app.key}Title`)} />
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-site-muted">
                  {t(`site.home.apps.${app.key}Body`)}
                </p>
                <p className="mt-6 font-mono text-xs text-site-fg/70">
                  {t(`site.home.apps.${app.key}Tags`)}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* From paper to the phone */}
      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-8 sm:pb-32">
        <Eyebrow>{t('site.home.stepsEyebrow')}</Eyebrow>
        <h2 className="font-display text-4xl font-semibold sm:text-6xl">
          <RevealText text={t('site.home.stepsTitle')} />
        </h2>
        <ol className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li
              key={step.key}
              className="relative flex min-h-72 flex-col justify-between overflow-hidden rounded-[2rem] border border-site-line bg-site-soft p-7"
            >
              <div
                aria-hidden="true"
                className="site-glow size-48 opacity-25"
                style={{
                  background: step.colour,
                  insetBlockStart: '-4rem',
                  insetInlineEnd: '-4rem',
                }}
              />
              <span
                aria-hidden="true"
                className="text-outline relative font-display text-7xl leading-none font-extrabold"
              >
                {`0${String(index + 1)}`}
              </span>
              <div className="relative mt-10">
                <h3 className="font-display text-xl font-semibold" style={{ color: step.colour }}>
                  {t(`site.home.steps.${step.key}Title`)}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-site-muted">
                  {t(`site.home.steps.${step.key}Body`)}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div aria-hidden="true" className="site-rule mt-12" />
      </section>

      {/* A few of the fifteen features */}
      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-8 sm:pb-32">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Eyebrow>{t('site.home.highlightsEyebrow')}</Eyebrow>
            <h2 className="max-w-2xl font-display text-3xl font-semibold sm:text-5xl">
              <RevealText text={t('site.home.highlightsTitle')} />
            </h2>
          </div>
          <Magnetic>
            <Link href="/features" className={pillClass('outline', 'sm')}>
              {t('site.home.allFeatures')}
              <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
                →
              </span>
            </Link>
          </Magnetic>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-site-line bg-site-line sm:grid-cols-2 lg:grid-cols-3">
          {HIGHLIGHTS.map((key) => (
            <article key={key} className="flex flex-col gap-3 bg-site-bg p-7">
              <span aria-hidden="true" className="size-2 rounded-full bg-lime" />
              <h3 className="font-display text-lg font-semibold">
                {t(`site.features.items.${key}.title`)}
              </h3>
              <p className="text-sm leading-relaxed text-site-muted">
                {t(`site.features.items.${key}.body`)}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Contact */}
      <section className="relative isolate overflow-hidden border-t border-site-line px-4 py-24 sm:px-8 sm:py-32">
        <div
          aria-hidden="true"
          className="site-glow -z-10 size-[30rem] bg-violet opacity-20"
          style={{ insetBlockEnd: '-12rem', insetInlineStart: '30%' }}
        />
        <div className="mx-auto max-w-6xl">
          <Eyebrow>{t('site.home.ctaEyebrow')}</Eyebrow>
          <h2 className="font-display text-5xl leading-none font-extrabold uppercase sm:text-8xl lg:text-9xl">
            <RevealText text={t('site.home.ctaTitle')} />
            <span className="text-lime">.</span>
          </h2>
          <div className="mt-10 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-xl text-base leading-relaxed text-site-muted sm:text-lg">
              {t('site.home.ctaBody')}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Magnetic>
                <GetStartedLink />
              </Magnetic>
              <a
                href={`mailto:${email}`}
                dir="ltr"
                className="font-mono text-sm text-site-fg underline decoration-site-line underline-offset-4 hover:text-lime"
              >
                {email}
              </a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
