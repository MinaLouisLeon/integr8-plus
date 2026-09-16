'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { MarketingShell } from '~/components/marketing-shell';
import { HELP_ARTICLES, HELP_CATEGORIES } from '~/lib/help-articles';

/**
 * The help centre (P18).
 *
 * Every article on one page, grouped, with each answer visible rather than
 * behind a click. Fifteen short answers fit; making somebody navigate to read
 * three paragraphs is friction for no gain, and a single page is one Ctrl-F
 * away from being searchable without any search to build.
 *
 * The notice at the top is the honest part: the plan asks for articles written
 * from real support questions, and there are no customers yet.
 */
export default function HelpPage() {
  const { t } = useTranslation();

  return (
    <MarketingShell>
      <header className="flex flex-col gap-2 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-content">
          {t('marketing.help.title')}
        </h1>
        <p className="text-content-muted">{t('marketing.help.subtitle')}</p>
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content-muted">
          {t('marketing.help.draftNotice')}
        </p>
      </header>

      <div className="flex flex-col gap-10">
        {HELP_CATEGORIES.map((category) => {
          const articles = HELP_ARTICLES.filter((article) => article.category === category.key);
          if (articles.length === 0) {
            return null;
          }

          return (
            <section key={category.key} className="flex flex-col gap-6">
              <h2 className="text-xl font-semibold text-content">{category.label}</h2>
              {articles.map((article) => (
                <article key={article.slug} id={article.slug} className="flex flex-col gap-2">
                  <h3 className="text-base font-medium text-content">{article.question}</h3>
                  {article.answer.map((paragraph) => (
                    <p
                      key={paragraph.slice(0, 32)}
                      className="max-w-prose text-sm text-content-muted"
                    >
                      {paragraph}
                    </p>
                  ))}
                </article>
              ))}
            </section>
          );
        })}
      </div>

      <div className="pt-10">
        <Link
          href="/sign-up"
          className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t('marketing.hero.cta')}
        </Link>
      </div>
    </MarketingShell>
  );
}
