import type { AiHelpArticle } from '@integr8/db';
import { describe, expect, it } from 'vitest';
import { HelpIndex, normaliseText, tokenise } from './retrieval.js';

/**
 * Finding help in two languages without a stemmer (ADR-0001 D7). The Arabic
 * cases are the ones an English-only index gets wrong: diacritics, the alef
 * and yaa variants, a taa marbuta, and the clitics that glue onto a word.
 */

function article(
  key: string,
  locale: 'en' | 'ar',
  title: string,
  body: string,
  keywords: string[] = [],
  extra: Partial<AiHelpArticle> = {},
): AiHelpArticle {
  return {
    articleKey: key,
    locale,
    module: 'work_orders',
    title,
    summary: title,
    body,
    keywords,
    appRoute: null,
    helpUrl: null,
    feature: null,
    minPermission: null,
    sourceCommit: null,
    contentHash: `${key}-${locale}`,
    status: 'published',
    updatedAt: new Date('2026-10-15T00:00:00Z'),
    ...extra,
  };
}

describe('normalisation', () => {
  it('folds Arabic letter variants, drops diacritics and the tatweel', () => {
    expect(normaliseText('أَوامِرُ العَمَل')).toBe('اوامر العمل');
    expect(normaliseText('إلى الفاتورة')).toBe('الي الفاتوره');
    expect(normaliseText('مـــخــزون')).toBe('مخزون');
    expect(normaliseText('مسؤول')).toBe('مسوول');
  });

  it('lower-cases English and strips punctuation', () => {
    expect(tokenise('How do I create a Work-Order?')).toEqual([
      'how',
      'do',
      'create',
      'work',
      'order',
    ]);
  });
});

describe('the index', () => {
  const index = new HelpIndex([
    article('work_orders', 'en', 'Work orders', 'Create, assign and finish jobs.', [
      'job',
      'visit',
    ]),
    article('invoices', 'en', 'Invoices', 'Issue an invoice to a customer and record payment.', [
      'bill',
    ]),
    article('work_orders', 'ar', 'أوامر العمل', 'إنشاء المهام وإسنادها وإنهاؤها.', [
      'مهمة',
      'زيارة',
    ]),
    article('invoices', 'ar', 'الفواتير', 'إصدار فاتورة للعميل وتسجيل الدفع.', ['فاتورة']),
    article('secret', 'en', 'Payroll', 'Run payroll.', [], {
      feature: 'payroll',
      minPermission: 'payroll.run',
    }),
  ]);

  it('ranks the article about the question first, in the asked language only', () => {
    const english = index.search('how do I invoice a customer', { locale: 'en' });
    expect(english[0]?.article.articleKey).toBe('invoices');
    expect(english.every((hit) => hit.article.locale === 'en')).toBe(true);

    const arabic = index.search('كيف أصدر فاتورة للعميل؟', { locale: 'ar' });
    expect(arabic[0]?.article.articleKey).toBe('invoices');
  });

  it('reads through Arabic clitics and plurals of the keywords', () => {
    expect(index.search('بالفواتير', { locale: 'ar' })[0]?.article.articleKey).toBe('invoices');
    expect(index.search('my jobs today', { locale: 'en' })[0]?.article.articleKey).toBe(
      'work_orders',
    );
  });

  it('offers nothing it was told not to, and nothing for an empty question', () => {
    expect(
      index.search('payroll', { locale: 'en', allow: (candidate) => candidate.feature === null }),
    ).toEqual([]);
    expect(index.search('   ', { locale: 'en' })).toEqual([]);
    expect(index.search('quantum chromodynamics', { locale: 'en' })).toEqual([]);
  });

  it('skips disabled articles', () => {
    const disabled = new HelpIndex([
      article('gone', 'en', 'Invoices', 'Issue an invoice.', [], { status: 'disabled' }),
    ]);
    expect(disabled.size).toBe(0);
    expect(disabled.search('invoice', { locale: 'en' })).toEqual([]);
  });
});
