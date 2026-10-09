import { describe, expect, it } from 'vitest';
import { ar } from './ar.js';
import { en } from './en.js';

/**
 * The two catalogues are one catalogue in two languages.
 *
 * A key English has and Arabic lacks is a sentence an Arabic reader sees in
 * English. A placeholder one has and the other lacks is a sentence with a hole
 * in it, or a value that is never shown. An Arabic value identical to its
 * English one is a line a translator skipped. None of these is caught by the
 * type system alone — the first is, but only until somebody widens a type to
 * make a build pass — so this test walks both trees and says exactly what
 * differs.
 */

interface Tree {
  readonly [key: string]: string | Tree;
}

/** Flattens a catalogue to `dotted.key → value`. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(path, value);
    } else {
      for (const [innerKey, innerValue] of flatten(value, path)) {
        out.set(innerKey, innerValue);
      }
    }
  }
  return out;
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/u;
const ENGLISH_PLURAL_SUFFIX = /_(one|other)$/u;
/** The Arabic forms English does not have; allowed only beside an English `_one`. */
const ARABIC_ONLY_SUFFIXES = ['zero', 'two', 'few', 'many'] as const;
/** The forms whose number is in the word itself, so `{{count}}` may be absent. */
const COUNT_IN_THE_WORD = new Set(['zero', 'one', 'two']);

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(/\{\{(\w+)\}\}/gu)].map(([, name]) => name ?? ''));
}

function stemOf(key: string): string {
  return key.replace(PLURAL_SUFFIX, '');
}

/**
 * Values allowed to be the same in both languages: product and vendor names,
 * file formats, and messages that are nothing but placeholders and punctuation.
 */
const SAME_IN_BOTH = new Set([
  'common.appName',
  'workspace.billing.invoicePdf',
  'platform.storage.cloudflare',
]);

function isOnlyPlaceholdersAndPunctuation(value: string): boolean {
  return value.replace(/\{\{\w+\}\}/gu, '').replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

const english = flatten(en);
const arabic = flatten(ar);

describe('catalogue parity', () => {
  it('has an Arabic value for every English key', () => {
    const missing = [...english.keys()].filter((key) => !arabic.has(key));
    expect(missing, `keys in en.ts with no Arabic:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no Arabic key English lacks, other than the extra plural forms', () => {
    const extra = [...arabic.keys()].filter((key) => {
      if (english.has(key)) {
        return false;
      }
      const match = PLURAL_SUFFIX.exec(key);
      const suffix = match?.[1];
      if (!suffix || !(ARABIC_ONLY_SUFFIXES as readonly string[]).includes(suffix)) {
        return true;
      }
      return !english.has(`${stemOf(key)}_one`);
    });
    expect(extra, `keys in ar.ts that en.ts does not have:\n${extra.join('\n')}`).toEqual([]);
  });

  it('carries every Arabic plural form wherever English pluralises', () => {
    // i18next picks the suffix with Intl.PluralRules('ar'), which has six
    // categories. A missing one falls through to English.
    const stems = new Set(
      [...english.keys()].filter((key) => ENGLISH_PLURAL_SUFFIX.test(key)).map(stemOf),
    );
    const missing = [...stems].flatMap((stem) =>
      ['zero', 'one', 'two', 'few', 'many', 'other']
        .map((suffix) => `${stem}_${suffix}`)
        .filter((key) => !arabic.has(key)),
    );
    expect(missing, `plural forms missing from ar.ts:\n${missing.join('\n')}`).toEqual([]);
  });

  it('interpolates the same placeholders as English, key by key', () => {
    const mismatched: string[] = [];
    for (const [key, arabicValue] of arabic) {
      // An Arabic-only plural form is compared against the English `_other`,
      // which is the form that carries every placeholder.
      const englishValue = english.get(key) ?? english.get(`${stemOf(key)}_other`);
      if (englishValue === undefined) {
        continue;
      }
      const expected = placeholders(englishValue);
      const actual = placeholders(arabicValue);
      const suffix = PLURAL_SUFFIX.exec(key)?.[1] ?? '';
      if (COUNT_IN_THE_WORD.has(suffix)) {
        // "two problems" is one word in Arabic; the number need not be printed.
        expected.delete('count');
        actual.delete('count');
      }
      const missing = [...expected].filter((name) => !actual.has(name));
      const unexpected = [...actual].filter((name) => !expected.has(name));
      if (missing.length > 0 || unexpected.length > 0) {
        mismatched.push(
          `${key}: missing [${missing.join(', ')}] unexpected [${unexpected.join(', ')}]`,
        );
      }
    }
    expect(mismatched, `placeholder sets that differ:\n${mismatched.join('\n')}`).toEqual([]);
  });

  it('translates every value, allowing only names and tokens to stay the same', () => {
    const untranslated = [...arabic]
      .filter(([key, value]) => {
        const englishValue = english.get(key);
        if (englishValue === undefined || englishValue !== value) {
          return false;
        }
        return !SAME_IN_BOTH.has(key) && !isOnlyPlaceholdersAndPunctuation(value);
      })
      .map(([key, value]) => `${key} = ${value}`);
    expect(untranslated, `Arabic values identical to English:\n${untranslated.join('\n')}`).toEqual(
      [],
    );
  });

  it('keeps product names in Latin letters', () => {
    // A transliterated brand is a different brand.
    const brands = /\b(Integr8 Plus|Integr8|Stripe|Supabase|Expo|SQLCipher|Cloudflare)\b/gu;
    const transliterated: string[] = [];
    for (const [key, value] of arabic) {
      for (const [name] of (english.get(key) ?? '').matchAll(brands)) {
        if (!value.includes(name)) {
          transliterated.push(`${key} should still name ${name}`);
        }
      }
    }
    expect(transliterated).toEqual([]);
  });
});
