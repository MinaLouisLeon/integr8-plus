import type { LocalizedText } from '@integr8/form-engine';

/**
 * Text an admin wrote, in the language being shown.
 *
 * Falls back to English, then to whatever language the text was written in,
 * because a label in the wrong language is still more useful than no label.
 */
export function say(text: Readonly<Record<string, string>> | undefined, locale: string): string {
  if (text === undefined) {
    return '';
  }
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
}

/**
 * The same text with the language being edited replaced.
 *
 * An empty string removes that language rather than storing `""`, which the
 * definition schema refuses — and if it was the only language, the result is
 * `undefined`, so an optional property like help text simply goes away.
 */
export function withText(
  text: LocalizedText | undefined,
  locale: string,
  value: string,
): LocalizedText | undefined {
  const next: Record<string, string> = { ...(text ?? {}) };
  if (value === '') {
    delete next[locale];
  } else {
    next[locale] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}
