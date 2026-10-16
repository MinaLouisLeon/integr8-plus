import type { AiHelpArticle } from '@integr8/db';
import { describe, expect, it } from 'vitest';
import { bestParagraph, LIBRARY_SOURCES, libraryAnswer } from './answer.js';

/**
 * Library answers (ADR-0002 D10): made of the articles retrieval found, with
 * no word the library does not hold beyond two fixed sentences.
 */

function article(key: string, overrides: Partial<AiHelpArticle> = {}): AiHelpArticle {
  return {
    articleKey: key,
    locale: 'en',
    module: 'work',
    title: `Title of ${key}`,
    summary: `Summary of ${key}.`,
    body: 'First paragraph about customers.\n\nSecond paragraph: create a work order from the Work orders screen.\n\nThird paragraph about invoices.',
    keywords: [],
    appRoute: 'work_orders',
    helpUrl: null,
    feature: null,
    minPermission: null,
    sourceCommit: null,
    contentHash: 'h',
    status: 'published',
    ...overrides,
  } as AiHelpArticle;
}

describe('the paragraph an answer quotes', () => {
  it('is the one sharing most terms with the question', () => {
    expect(bestParagraph(article('a').body, 'How do I create a work order?')).toMatch(
      /^Second paragraph/u,
    );
  });

  it('is the first when nothing matches, and is cut when long', () => {
    expect(bestParagraph(article('a').body, 'zzz')).toMatch(/^First paragraph/u);
    const long = bestParagraph('word '.repeat(600), 'word');
    expect(long.length).toBeLessThanOrEqual(1201);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads Arabic the way the index does', () => {
    const body = 'فقرة عن الفواتير.\n\nفقرة عن العملاء والمواقع.';
    expect(bestParagraph(body, 'كيف أضيف عملاء؟')).toMatch(/العملاء/u);
  });
});

describe('a library answer', () => {
  it('is the best article’s title, summary and paragraph, with the articles found as sources', () => {
    const found = ['a', 'b', 'c', 'd', 'e'].map((key) => article(key));
    const answer = libraryAnswer('create a work order', found, 'en', { guideOnlyForNow: false });
    expect(answer.text.split('\n\n')).toEqual([
      'Title of a',
      'Summary of a.',
      'Second paragraph: create a work order from the Work orders screen.',
    ]);
    expect(answer.sources).toHaveLength(LIBRARY_SOURCES);
    expect(answer.sources[0]).toEqual({
      kind: 'help',
      articleKey: 'a',
      label: 'Title of a',
      appRoute: 'work_orders',
      helpUrl: null,
    });
  });

  it('says when nothing was found, in the member’s language, and cites nothing', () => {
    expect(libraryAnswer('zzz', [], 'en', { guideOnlyForNow: false })).toEqual({
      text: 'I could not find anything about that in the help guide. Try other words, or contact Integr8.',
      sources: [],
    });
    expect(libraryAnswer('zzz', [], 'ar', { guideOnlyForNow: false }).text).toMatch(
      /دليل المساعدة/u,
    );
  });

  it('says first when only the guide can answer for now', () => {
    const answer = libraryAnswer('create a work order', [article('a')], 'en', {
      guideOnlyForNow: true,
    });
    expect(answer.text).toMatch(/^Right now I can only answer from the help guide\./u);
    expect(answer.text).toContain('Title of a');
  });
});
