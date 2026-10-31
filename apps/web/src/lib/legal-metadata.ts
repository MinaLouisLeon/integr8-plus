import type { LegalDocument } from '@integr8/core';
import { ar, en } from '@integr8/i18n/core';
import type { Metadata } from 'next';
import { readPreferences } from './preferences';

/**
 * The browser title and search description of a legal page, in the reader's
 * language. Server-side, from the same catalogue the page uses, because the
 * title is what a store reviewer or a search result shows before anybody
 * opens the page.
 */
export async function legalMetadata(document: LegalDocument): Promise<Metadata> {
  const { locale } = await readPreferences();
  const messages = locale === 'ar' ? ar : en;
  return {
    title: `${messages.legal.documents[document]} · ${messages.common.appName}`,
    description: messages.legal[document].summary,
  };
}
