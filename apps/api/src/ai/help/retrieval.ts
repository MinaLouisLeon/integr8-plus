import type { AiHelpArticle } from '@integr8/db';

/**
 * Finding the help articles a question is about (docs/ai §7.2; ADR-0001 D7).
 *
 * Lexical, in process, over the published articles: every term in the
 * question is normalised the way the article text was, and articles are
 * scored BM25-style over their title, keywords, summary and body, with the
 * title and keywords weighted up. No vector service, no network, no English
 * stemmer pretending to understand Arabic.
 *
 * Arabic normalisation does what a reader does without noticing: drops the
 * diacritics and the tatweel, folds the alef and yaa variants, and reads a
 * final taa marbuta as haa. English is lower-cased and stripped of
 * punctuation. Both are tokenised on whitespace, and the leading Arabic
 * clitics (و, ب, ل, ك, ال) are tried both with and without, so «العملاء»
 * finds «عملاء».
 */

const DIACRITICS = /[ً-ٰٟـ]/gu;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replaceAll(/[إأآٱ]/gu, 'ا')
    .replaceAll('ى', 'ي')
    .replaceAll('ئ', 'ي')
    .replaceAll('ؤ', 'و')
    .replaceAll('ة', 'ه')
    .replace(PUNCTUATION, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

const ARABIC_PREFIXES = ['وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل', 'ك', 'ف'];

/** The term, and the stems a clitic could be hiding. Short tokens stay whole. */
function variants(token: string): string[] {
  const out = new Set<string>([token]);
  if (/^[؀-ۿ]+$/u.test(token)) {
    for (const prefix of ARABIC_PREFIXES) {
      if (token.startsWith(prefix) && token.length - prefix.length >= 3) {
        out.add(token.slice(prefix.length));
      }
    }
  } else if (token.length > 4 && token.endsWith('s')) {
    out.add(token.slice(0, -1));
  }
  return [...out];
}

export function tokenise(text: string): string[] {
  return normaliseText(text)
    .split(' ')
    .filter((token) => token.length >= 2);
}

interface IndexedArticle {
  article: AiHelpArticle;
  /** Term → weighted frequency across the fields. */
  terms: Map<string, number>;
  length: number;
}

const FIELD_WEIGHTS = { title: 4, keywords: 3, summary: 2, body: 1 } as const;
const K1 = 1.2;
const B = 0.75;

export interface RetrievedArticle {
  article: AiHelpArticle;
  score: number;
}

export class HelpIndex {
  readonly #entries: IndexedArticle[] = [];
  readonly #documentFrequency = new Map<string, number>();
  #averageLength = 1;
  readonly fingerprint: string;

  constructor(articles: readonly AiHelpArticle[]) {
    this.fingerprint = articles
      .map((article) => `${article.articleKey}:${article.locale}:${article.contentHash}`)
      .sort()
      .join('|');
    for (const article of articles) {
      if (article.status !== 'published') {
        continue;
      }
      const terms = new Map<string, number>();
      let length = 0;
      const add = (text: string, weight: number) => {
        for (const token of tokenise(text)) {
          for (const variant of variants(token)) {
            terms.set(variant, (terms.get(variant) ?? 0) + weight);
          }
          length += weight;
        }
      };
      add(article.title, FIELD_WEIGHTS.title);
      add(article.keywords.join(' '), FIELD_WEIGHTS.keywords);
      add(article.summary, FIELD_WEIGHTS.summary);
      add(article.body, FIELD_WEIGHTS.body);
      this.#entries.push({ article, terms, length: Math.max(1, length) });
      for (const term of terms.keys()) {
        this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const total = this.#entries.reduce((sum, entry) => sum + entry.length, 0);
    this.#averageLength = this.#entries.length === 0 ? 1 : total / this.#entries.length;
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * The best articles for a question, in the asked locale, among those the
   * caller may offer. Articles the member's company lacks the module for, or
   * the member lacks the permission for, are filtered before scoring so they
   * can neither be cited nor leak by their absence.
   */
  search(
    question: string,
    options: {
      locale: string;
      limit?: number;
      allow?: (article: AiHelpArticle) => boolean;
    },
  ): RetrievedArticle[] {
    const query = new Set(tokenise(question).flatMap(variants));
    if (query.size === 0) {
      return [];
    }
    const count = this.#entries.length;
    const results: RetrievedArticle[] = [];
    for (const entry of this.#entries) {
      if (entry.article.locale !== options.locale) {
        continue;
      }
      if (options.allow !== undefined && !options.allow(entry.article)) {
        continue;
      }
      let score = 0;
      for (const term of query) {
        const frequency = entry.terms.get(term);
        if (frequency === undefined) {
          continue;
        }
        const documents = this.#documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (count - documents + 0.5) / (documents + 0.5));
        const normalised =
          (frequency * (K1 + 1)) /
          (frequency + K1 * (1 - B + (B * entry.length) / this.#averageLength));
        score += idf * normalised;
      }
      if (score > 0) {
        results.push({ article: entry.article, score });
      }
    }
    results.sort(
      (a, b) => b.score - a.score || a.article.articleKey.localeCompare(b.article.articleKey),
    );
    return results.slice(0, options.limit ?? 5);
  }
}
