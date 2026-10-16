import type { AiSourceRef } from '@integr8/core';
import type { AiHelpArticle } from '@integr8/db';
import { termsOf } from './retrieval.js';

/**
 * An answer made from the help library alone, with no model (ADR-0002 D10).
 *
 * The articles come from the same retrieval the model's answers use, already
 * filtered to the member's language, modules and permissions. The answer is
 * the best article's title and summary, and the paragraph of its body that
 * shares most terms with the question; every article found is a source, so
 * the screen links to each. Nothing here invents a word the library does not
 * hold, apart from the two fixed sentences below.
 */

/** How many articles an answer names as sources. */
export const LIBRARY_SOURCES = 3;
const MAX_PARAGRAPH_CHARS = 1200;

export function sourceOf(article: AiHelpArticle): AiSourceRef {
  return {
    kind: 'help',
    articleKey: article.articleKey,
    label: article.title,
    appRoute: article.appRoute,
    helpUrl: article.helpUrl,
  };
}

/** The paragraph of `body` that shares most terms with the question; the first on a tie. */
export function bestParagraph(body: string, question: string): string {
  const paragraphs = body
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
  const asked = termsOf(question);
  let best = paragraphs[0] ?? '';
  let bestScore = 0;
  for (const paragraph of paragraphs) {
    let score = 0;
    for (const term of termsOf(paragraph)) {
      if (asked.has(term)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      best = paragraph;
      bestScore = score;
    }
  }
  return best.length > MAX_PARAGRAPH_CHARS
    ? `${best.slice(0, MAX_PARAGRAPH_CHARS).trimEnd()}…`
    : best;
}

const NOTHING_FOUND = {
  en: 'I could not find anything about that in the help guide. Try other words, or contact Integr8.',
  ar: 'لم أجد شيئًا عن هذا في دليل المساعدة. جرّب كلمات أخرى، أو تواصل مع Integr8.',
} as const;

const GUIDE_ONLY_FOR_NOW = {
  en: 'Right now I can only answer from the help guide. Questions about your company’s records will work again shortly.',
  ar: 'لا يمكنني الآن الإجابة إلا من دليل المساعدة. ستعمل الأسئلة عن سجلات شركتك مرة أخرى قريبًا.',
} as const;

export function libraryAnswer(
  question: string,
  references: readonly AiHelpArticle[],
  locale: 'en' | 'ar',
  options: { guideOnlyForNow: boolean },
): { text: string; sources: AiSourceRef[] } {
  const top = references[0];
  const parts: string[] = [];
  if (options.guideOnlyForNow) {
    parts.push(GUIDE_ONLY_FOR_NOW[locale]);
  }
  if (top === undefined) {
    parts.push(NOTHING_FOUND[locale]);
    return { text: parts.join('\n\n'), sources: [] };
  }
  parts.push(top.title, top.summary);
  const paragraph = bestParagraph(top.body, question);
  if (paragraph !== '' && paragraph !== top.summary) {
    parts.push(paragraph);
  }
  return {
    text: parts.join('\n\n'),
    sources: references.slice(0, LIBRARY_SOURCES).map(sourceOf),
  };
}
