import { ar, en } from '@integr8/i18n/core';

/**
 * The few words a generated PDF prints itself, in the document's language:
 * yes and no, ticked, page numbers. They live in the i18n catalogues like
 * every other string (`documents.render`); this reads them without React.
 */

export type DocumentLocale = 'en' | 'ar';
export type RenderWords = { readonly [K in keyof (typeof en)['documents']['render']]: string };

export function wordsFor(locale: DocumentLocale): RenderWords {
  return locale === 'ar' ? ar.documents.render : en.documents.render;
}

/** `{{name}}` in a catalogue string, replaced by the values given; unknown names are left as they are. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}
