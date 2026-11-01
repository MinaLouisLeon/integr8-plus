'use client';

import { useTranslation } from '@integr8/i18n';
import { GetStartedLink, MarketingShell, PageIntro } from '~/components/marketing-shell';
import { Magnetic, ScrambleText } from '~/components/site/motion';
import { FEATURES, GROUP_COLOUR } from '~/lib/site-content';

/**
 * Features (P18, rewritten for Low 3).
 *
 * The fifteen things the product does today, each a short paragraph with no
 * adjectives, in English and Arabic (`site.features.items.*`). If one stops
 * being true, that is a bug in the product or a lie on this page, and both are
 * worth fixing. The order and groups are in `~/lib/site-content`.
 */
export default function FeaturesPage() {
  const { t } = useTranslation();

  return (
    <MarketingShell step="features.viewed">
      <PageIntro
        eyebrow={t('site.features.eyebrow')}
        title={t('site.features.title')}
        gradient={t('site.features.titleGradient')}
        subtitle={t('site.features.subtitle')}
      />

      <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <li
            key={feature.key}
            className="group relative flex flex-col gap-4 overflow-hidden rounded-3xl border border-site-line bg-site-soft p-7 transition-colors duration-300 hover:border-white/20"
          >
            <div
              aria-hidden="true"
              className="site-glow size-48 opacity-10 transition-opacity duration-500 group-hover:opacity-30"
              style={{
                background: GROUP_COLOUR[feature.group],
                insetBlockStart: '-4rem',
                insetInlineEnd: '-4rem',
              }}
            />
            <div className="relative flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-site-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span
                className="rounded-full border border-site-line px-3 py-1 font-mono text-[11px] tracking-[0.15em] uppercase rtl:tracking-normal"
                style={{ color: GROUP_COLOUR[feature.group] }}
              >
                {t(`site.features.groups.${feature.group}`)}
              </span>
            </div>
            <h2 className="relative font-display text-xl leading-snug font-semibold">
              <ScrambleText text={t(`site.features.items.${feature.key}.title`)} />
            </h2>
            <p className="relative text-sm leading-relaxed text-site-muted">
              {t(`site.features.items.${feature.key}.body`)}
            </p>
          </li>
        ))}
      </ol>

      <div className="mt-16 flex flex-wrap items-center gap-4">
        <Magnetic>
          <GetStartedLink />
        </Magnetic>
      </div>
    </MarketingShell>
  );
}
