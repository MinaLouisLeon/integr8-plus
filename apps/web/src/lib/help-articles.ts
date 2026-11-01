import type { Locale } from '@integr8/i18n';
import { helpArticlesFor as libraryArticlesFor } from '@integr8/i18n/help';

/**
 * The public Help centre's content (P18, Low 12).
 *
 * The articles are the same help library the in-app assistant answers from
 * (`@integr8/i18n/help`), so the Help centre and the assistant never say two
 * different things, and both are kept in English and Arabic in one place. The
 * library marks which articles are public; those are the ones shown here,
 * grouped by category, each a question with plain paragraphs (no markup).
 */

/** One article as the Help centre renders it. */
export interface HelpArticle {
  slug: string;
  category: string;
  categoryLabel: string;
  question: string;
  /** Paragraphs, in order, plain text. */
  answer: string[];
}

/** The public articles in one language, grouped by category in display order. */
export function helpArticlesFor(locale: Locale): readonly HelpArticle[] {
  return libraryArticlesFor(locale);
}
