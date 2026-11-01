import type { Locale } from '../locales.js';
import { HELP_ARTICLES } from './articles.js';
import {
  type HelpArticleSource,
  PUBLIC_HELP_CATEGORIES,
  type PublicHelpCategory,
} from './types.js';

/**
 * The public Help centre's view of the library (P18, Low 12): the articles
 * marked `public`, in one language, as questions with plain paragraphs, in
 * category order. The same text the assistant answers from, so the two never
 * disagree.
 */

/** An article as the public Help centre renders it. `answer` is plain paragraphs, no markup. */
export interface HelpArticle {
  slug: string;
  category: string;
  categoryLabel: string;
  question: string;
  answer: string[];
}

const CATEGORY_LABELS: Readonly<Record<PublicHelpCategory, { en: string; ar: string }>> = {
  'getting-started': { en: 'Getting started', ar: 'البداية' },
  'field-work': { en: 'Jobs and the schedule', ar: 'المهام والجدول' },
  'phone-app': { en: 'The phone app', ar: 'تطبيق الهاتف' },
  'forms-documents': { en: 'Forms and documents', ar: 'النماذج والمستندات' },
  'sales-finance': { en: 'Sales and money', ar: 'المبيعات والمال' },
  'stock-assets': { en: 'Stock and assets', ar: 'المخزون والأصول' },
  'people-hr': { en: 'People and HR', ar: 'الأشخاص والموارد البشرية' },
  'account-billing': { en: 'Your account and billing', ar: 'حسابك والفوترة' },
};

/** The URL-safe name of an article in the Help centre. */
export function helpSlug(key: string): string {
  return key.replace(/_/gu, '-');
}

/** An article's body as paragraphs: split on blank lines, trimmed, none empty. */
export function helpParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** The public articles in one language, grouped by category in the Help centre's order. */
export function helpArticlesFor(
  locale: Locale,
  sources: readonly HelpArticleSource[] = HELP_ARTICLES,
): readonly HelpArticle[] {
  const order = new Map<string, number>(
    PUBLIC_HELP_CATEGORIES.map((category, index) => [category, index]),
  );
  return sources
    .flatMap((source) => (source.public === null ? [] : [{ source, placement: source.public }]))
    .sort((a, b) => (order.get(a.placement.category) ?? 0) - (order.get(b.placement.category) ?? 0))
    .map(({ source, placement }) => ({
      slug: helpSlug(source.key),
      category: placement.category,
      categoryLabel: CATEGORY_LABELS[placement.category][locale],
      question: placement.question[locale],
      answer: helpParagraphs(source[locale].body),
    }));
}
