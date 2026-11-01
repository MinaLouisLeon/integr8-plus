import { createHash } from 'node:crypto';
import {
  type AiHelpArticle,
  getPlatformDataSource,
  type UpsertAiHelpArticleInput,
} from '@integr8/db';
import { HELP_ARTICLES, type HelpArticleSource } from '@integr8/i18n/help';
import { HelpIndex } from './retrieval.js';

/**
 * The help library as the API holds it (docs/ai §7.2; ADR-0001 D7).
 *
 * The checked-in manifest (`@integr8/i18n/help`, shared with the web app's
 * public Help centre) is the source; the table is where it is served
 * from; the index is built from the table and rebuilt when the table changes.
 * Seeding is idempotent by content hash, so a restart that changes nothing
 * writes nothing, and an article dropped from the manifest is disabled (never
 * cited again) rather than deleted.
 */

const REFRESH_MS = 60_000;

export function articleHash(article: HelpArticleSource, locale: 'en' | 'ar'): string {
  const text = article[locale];
  return createHash('sha256')
    .update(
      JSON.stringify([
        article.key,
        locale,
        article.module,
        article.feature,
        article.minPermission,
        article.appRoute,
        text.title,
        text.summary,
        text.body,
        text.keywords,
      ]),
    )
    .digest('hex');
}

export function manifestRows(
  sources: readonly HelpArticleSource[],
  sourceCommit: string | null,
): UpsertAiHelpArticleInput[] {
  return sources.flatMap((article) =>
    (['en', 'ar'] as const).map((locale) => ({
      articleKey: article.key,
      locale,
      module: article.module,
      title: article[locale].title,
      summary: article[locale].summary,
      body: article[locale].body,
      keywords: article[locale].keywords.map((keyword) => keyword.trim()).filter(Boolean),
      appRoute: article.appRoute,
      helpUrl: null,
      feature: article.feature,
      minPermission: article.minPermission,
      sourceCommit,
      contentHash: articleHash(article, locale),
    })),
  );
}

export class HelpLibrary {
  #index: HelpIndex | null = null;
  #articles: AiHelpArticle[] = [];
  #readAt = 0;
  #seeded = false;

  constructor(private readonly sourceCommit: string | null) {}

  /** Writes the manifest's articles that changed, disables the ones it dropped. */
  async seed(): Promise<{ written: number; disabled: number }> {
    const result = await getPlatformDataSource().ai.syncHelpArticles(
      manifestRows(HELP_ARTICLES, this.sourceCommit),
    );
    this.#seeded = true;
    this.#readAt = 0;
    return result;
  }

  /** The published articles, refreshed at most once a minute. */
  async articles(now = Date.now()): Promise<AiHelpArticle[]> {
    if (!this.#seeded) {
      await this.seed();
    }
    if (now - this.#readAt >= REFRESH_MS) {
      this.#articles = await getPlatformDataSource().ai.helpArticles();
      this.#readAt = now;
    }
    return this.#articles;
  }

  async index(now = Date.now()): Promise<HelpIndex> {
    const articles = await this.articles(now);
    const fingerprint = articles
      .map((article) => `${article.articleKey}:${article.locale}:${article.contentHash}`)
      .sort()
      .join('|');
    if (this.#index === null || this.#index.fingerprint !== fingerprint) {
      this.#index = new HelpIndex(articles);
    }
    return this.#index;
  }
}
