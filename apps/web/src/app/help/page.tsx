'use client';

import { isLocale, useTranslation } from '@integr8/i18n';
import { useMemo, useState } from 'react';
import { GetStartedLink, MarketingShell, PageIntro } from '~/components/marketing-shell';
import { Magnetic } from '~/components/site/motion';
import { helpArticlesFor, type HelpArticle } from '~/lib/help-articles';
import { contactEmail } from '~/lib/signup';

/**
 * The help centre (P18), in the Integr8 Media look (Low 3).
 *
 * Every article on one page, grouped, with each answer visible rather than
 * behind a click: making somebody navigate to read three paragraphs is
 * friction for no gain. The articles come in the reader's language from the
 * help library (`helpArticlesFor`), the same one the assistant answers from;
 * the box at the top narrows them as you type, and the topics jump to their
 * group.
 */
export default function HelpPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const locale = isLocale(language) ? language : 'en';
  const [query, setQuery] = useState('');
  const email = contactEmail();

  const articles = useMemo(() => helpArticlesFor(locale), [locale]);
  const groups = useMemo(() => groupByCategory(articles), [articles]);
  const needle = query.trim().toLocaleLowerCase(locale);
  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          articles:
            needle === ''
              ? group.articles
              : group.articles.filter((article) =>
                  [article.question, ...article.answer]
                    .join(' ')
                    .toLocaleLowerCase(locale)
                    .includes(needle),
                ),
        }))
        .filter((group) => group.articles.length > 0),
    [groups, needle, locale],
  );

  return (
    <MarketingShell>
      <PageIntro
        eyebrow={t('site.help.eyebrow')}
        title={t('site.help.title')}
        gradient={t('site.help.titleGradient')}
        subtitle={t('site.help.subtitle')}
      >
        <label className="mt-10 flex w-full max-w-xl flex-col gap-2">
          <span className="sr-only">{t('site.help.search')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('site.help.searchPlaceholder')}
            className="w-full rounded-full border border-site-line bg-white/[0.03] px-6 py-4 text-base text-site-fg placeholder:text-site-muted focus:border-lime"
          />
        </label>
      </PageIntro>

      <div className="grid gap-12 lg:grid-cols-[14rem_1fr]">
        <nav aria-labelledby="help-topics" className="lg:sticky lg:top-28 lg:self-start">
          <h2
            id="help-topics"
            className="mb-4 font-mono text-xs tracking-[0.2em] text-site-muted uppercase rtl:tracking-normal"
          >
            {t('site.help.categories')}
          </h2>
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {groups.map((group) => (
              <li key={group.category}>
                <a
                  href={`#topic-${group.category}`}
                  className="inline-flex rounded-full border border-site-line px-4 py-2 text-sm text-site-muted transition-colors hover:border-lime hover:text-site-fg lg:border-transparent lg:px-3 lg:py-1.5"
                >
                  {group.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex flex-col gap-14">
          {visible.length === 0 ? (
            <p role="status" className="text-site-muted">
              {t('site.help.noMatch', { query: query.trim() })}
            </p>
          ) : (
            visible.map((group) => (
              <section
                key={group.category}
                id={`topic-${group.category}`}
                aria-labelledby={`topic-${group.category}-title`}
                className="flex scroll-mt-28 flex-col gap-4"
              >
                <h2
                  id={`topic-${group.category}-title`}
                  className="font-display text-2xl font-semibold sm:text-3xl"
                >
                  {group.label}
                </h2>
                {group.articles.map((article) => (
                  <article
                    key={article.slug}
                    id={article.slug}
                    className="scroll-mt-28 rounded-3xl border border-site-line bg-site-soft p-6 sm:p-7"
                  >
                    <h3 className="text-lg font-semibold text-site-fg">{article.question}</h3>
                    <div className="mt-3 flex flex-col gap-3">
                      {article.answer.map((paragraph, index) => (
                        <p
                          key={`${article.slug}-${String(index)}`}
                          className="max-w-prose text-sm leading-relaxed text-site-muted sm:text-base"
                        >
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            ))
          )}

          <aside className="flex flex-col items-start gap-4 rounded-3xl border border-site-line p-7 sm:p-10">
            <h2 className="font-display text-2xl font-semibold">{t('site.help.stillStuck')}</h2>
            <p className="text-site-muted">{t('site.help.stillStuckBody')}</p>
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
          </aside>
        </div>
      </div>
    </MarketingShell>
  );
}

interface ArticleGroup {
  category: string;
  label: string;
  articles: HelpArticle[];
}

/** The articles by category, in the order each category first appears. */
function groupByCategory(articles: readonly HelpArticle[]): ArticleGroup[] {
  const groups = new Map<string, ArticleGroup>();
  for (const article of articles) {
    const group = groups.get(article.category);
    if (group === undefined) {
      groups.set(article.category, {
        category: article.category,
        label: article.categoryLabel,
        articles: [article],
      });
    } else {
      group.articles.push(article);
    }
  }
  return [...groups.values()];
}
