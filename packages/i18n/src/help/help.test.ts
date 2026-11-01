import { describe, expect, it } from 'vitest';
import { HELP_ARTICLES } from './articles.js';
import { helpArticlesFor, helpParagraphs, helpSlug } from './public.js';
import { PUBLIC_HELP_CATEGORIES } from './types.js';

/**
 * The help library's own rules. What it says about the product is checked by
 * people; these check what a reader or the database would trip over. That
 * every switchable module has an article is checked in the API, which knows
 * the modules (`apps/api/src/ai/help/articles.test.ts`).
 */

describe('the help library', () => {
  it('has unique keys the database accepts', () => {
    const keys = HELP_ARTICLES.map((article) => article.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
    }
  });

  it('says everything in both languages, within the database’s limits', () => {
    for (const article of HELP_ARTICLES) {
      for (const locale of ['en', 'ar'] as const) {
        const text = article[locale];
        expect(text.title.trim(), `${article.key} ${locale}`).not.toBe('');
        expect(text.summary.trim(), `${article.key} ${locale}`).not.toBe('');
        expect(text.body.trim(), `${article.key} ${locale}`).not.toBe('');
        expect(text.body.length, `${article.key} ${locale}`).toBeLessThanOrEqual(20_000);
        expect(text.keywords.length, `${article.key} ${locale}`).toBeGreaterThan(0);
      }
      // The Arabic is a translation, not the English again.
      expect(article.ar.body, article.key).not.toBe(article.en.body);
      // As many paragraphs in each language, so neither is missing a part.
      expect(helpParagraphs(article.ar.body).length, article.key).toBe(
        helpParagraphs(article.en.body).length,
      );
    }
  });

  it('is plain text, because the Help centre shows it as it is', () => {
    for (const article of HELP_ARTICLES) {
      for (const locale of ['en', 'ar'] as const) {
        expect(article[locale].body, `${article.key} ${locale}`).not.toMatch(
          /\*\*|__|<\/?[a-z]|^\s*[-*#] |\[[^\]]*\]\(/mu,
        );
      }
    }
  });
});

describe('the public Help centre', () => {
  it('shows the public articles, in both languages, grouped in category order', () => {
    const marked = HELP_ARTICLES.filter((article) => article.public !== null);
    for (const locale of ['en', 'ar'] as const) {
      const shown = helpArticlesFor(locale);
      expect(shown).toHaveLength(marked.length);
      const order = shown.map((article) =>
        PUBLIC_HELP_CATEGORIES.indexOf(article.category as (typeof PUBLIC_HELP_CATEGORIES)[number]),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
      for (const article of shown) {
        expect(article.question.trim()).not.toBe('');
        expect(article.categoryLabel.trim()).not.toBe('');
        expect(article.answer.length).toBeGreaterThan(0);
        expect(article.slug).toMatch(/^[a-z][a-z0-9-]*$/u);
      }
    }
  });

  it('answers in the language asked for', () => {
    const [english] = helpArticlesFor('en');
    const [arabic] = helpArticlesFor('ar');
    expect(english?.slug).toBe(arabic?.slug);
    expect(english?.question).not.toBe(arabic?.question);
    expect(arabic?.question).toMatch(/[؀-ۿ]/u);
  });

  it('leaves out an article that is not public', () => {
    const hidden = HELP_ARTICLES.filter((article) => article.public === null).map((article) =>
      helpSlug(article.key),
    );
    const shown = new Set(helpArticlesFor('en').map((article) => article.slug));
    expect(hidden.filter((slug) => shown.has(slug))).toEqual([]);
  });

  it('splits a body into its paragraphs', () => {
    expect(helpParagraphs('One.\n\nTwo\nlines.\n\n\n  Three.  ')).toEqual([
      'One.',
      'Two lines.',
      'Three.',
    ]);
  });
});
