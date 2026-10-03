import { describe, expect, it } from 'vitest';
import {
  createI18n,
  DEFAULT_LOCALE,
  directionFor,
  en,
  formatCurrency,
  formatDate,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  isLocale,
  isRtl,
  LOCALE_DESCRIPTORS,
  LOCALES,
  negotiateLocale,
  resetFormatterCache,
  resolveDirection,
} from './index.js';

describe('locales', () => {
  it('knows which way each one reads', () => {
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('ar')).toBe('rtl');
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('treats an unknown locale as left-to-right rather than throwing', () => {
    // A stray `Accept-Language` should not be able to break a page.
    expect(directionFor('xx')).toBe('ltr');
  });

  it('describes every declared locale', () => {
    expect(LOCALE_DESCRIPTORS.map((entry) => entry.code).sort()).toEqual([...LOCALES].sort());
  });

  it('names each language in its own language, which is what a switcher shows', () => {
    expect(LOCALE_DESCRIPTORS.find((entry) => entry.code === 'ar')?.nativeName).toBe('العربية');
  });

  it('declares Arabic as untranslated, which is the honest state today', () => {
    // Declared now so RTL layout can be checked from the first screen; the copy
    // itself is P32.
    expect(LOCALE_DESCRIPTORS.find((entry) => entry.code === 'ar')?.translated).toBe(false);
    expect(LOCALE_DESCRIPTORS.find((entry) => entry.code === 'en')?.translated).toBe(true);
  });

  it('recognises its own locales and rejects others', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});

describe('negotiation', () => {
  it('matches on the language, ignoring the region', () => {
    expect(negotiateLocale(['ar-EG', 'en-GB'])).toBe('ar');
    expect(negotiateLocale(['en-US'])).toBe('en');
  });

  it('takes the first it recognises, in the order asked for', () => {
    expect(negotiateLocale(['fr-FR', 'de-DE', 'ar'])).toBe('ar');
  });

  it('falls back when nothing matches', () => {
    expect(negotiateLocale(['fr', 'de'])).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale([])).toBe(DEFAULT_LOCALE);
  });

  it('is case-insensitive', () => {
    expect(negotiateLocale(['AR-SA'])).toBe('ar');
  });
});

describe('direction, and the development override', () => {
  /**
   * P05's third exit criterion depends on this. Forcing right-to-left while
   * still reading English is how a screen is checked for hardcoded `left` and
   * `right` before any Arabic copy exists — and checking each screen as it is
   * built costs nothing, where retrofitting is a rewrite.
   */
  it('follows the locale by default', () => {
    expect(resolveDirection('en')).toBe('ltr');
    expect(resolveDirection('ar')).toBe('rtl');
  });

  it('can be forced right-to-left without pretending the language changed', () => {
    expect(resolveDirection('en', true)).toBe('rtl');
  });

  it('does not force left-to-right on a right-to-left locale', () => {
    expect(resolveDirection('ar', false)).toBe('rtl');
  });
});

describe('the instance', () => {
  it('translates a key', () => {
    const i18n = createI18n();
    expect(i18n.t('auth.signIn')).toBe('Sign in');
  });

  it('interpolates', () => {
    const i18n = createI18n();
    expect(i18n.t('workspace.signedInAs', { name: 'Dana' })).toBe('Signed in as Dana');
  });

  it('handles plurals', () => {
    const i18n = createI18n();
    expect(i18n.t('workspace.members.count', { count: 1 })).toBe('1 person');
    expect(i18n.t('workspace.members.count', { count: 4 })).toBe('4 people');
  });

  it('shows English words for an untranslated locale, not raw keys', () => {
    // What makes the RTL preview usable: Arabic today is English text in a
    // mirrored layout, rather than a screen of `workspace.members.title`.
    const i18n = createI18n({ locale: 'ar' });
    expect(i18n.t('auth.signIn')).toBe('Sign in');
  });

  it('gives each caller its own instance', () => {
    // The Next.js server handles several requests at once. A shared singleton
    // would let one request's locale leak into another's response.
    const first = createI18n({ locale: 'en' });
    const second = createI18n({ locale: 'ar' });

    expect(first).not.toBe(second);
    expect(first.language).toBe('en');
    expect(second.language).toBe('ar');
  });

  it('does not escape, because React already does', () => {
    const i18n = createI18n();
    expect(i18n.t('workspace.signedInAs', { name: "O'Brien" })).toContain("O'Brien");
  });
});

describe('the message catalogue', () => {
  it('gives one message for every kind of failed sign-in', () => {
    // A wrong password, an unknown address and an account with no company all
    // read the same, so the form cannot be used to test which addresses are
    // customers.
    expect(en.auth.invalidCredentials).toBe('That email address and password did not match.');
  });

  it('asks for the request id in the error copy', () => {
    // The one thing that makes a report actionable, so the words ask for it
    // rather than hoping somebody thinks to include it.
    expect(en.errors.body).toContain('{{requestId}}');
  });
});

describe('formatting', () => {
  const when = new Date('2026-09-10T14:02:00.000Z');

  it('spells the month out rather than risking 03/04', () => {
    // `03/04/2026` is two different days on two sides of an ocean, and a job
    // sheet is not the place to find that out.
    const formatted = formatDate(when, { locale: 'en', timeZone: 'UTC' });

    expect(formatted).toContain('September');
    expect(formatted).toContain('2026');
  });

  it('accepts an ISO string as well as a Date, because the API sends strings', () => {
    expect(formatDate('2026-09-10T14:02:00.000Z', { locale: 'en', timeZone: 'UTC' })).toBe(
      formatDate(when, { locale: 'en', timeZone: 'UTC' }),
    );
  });

  it('formats relative times in both directions', () => {
    const now = new Date('2026-09-10T14:02:00.000Z');

    expect(formatRelativeTime(new Date(now.getTime() - 3 * 3600_000), { now })).toBe('3 hours ago');
    expect(formatRelativeTime(new Date(now.getTime() + 2 * 86_400_000), { now })).toBe('in 2 days');
  });

  it('chooses a sensible unit', () => {
    const now = new Date('2026-09-10T14:02:00.000Z');

    expect(formatRelativeTime(new Date(now.getTime() - 45_000), { now })).toContain('second');
    expect(formatRelativeTime(new Date(now.getTime() - 5 * 60_000), { now })).toContain('minute');
  });

  it('formats numbers, currency and percentages', () => {
    expect(formatNumber(1234.567, { locale: 'en' })).toBe('1,234.57');
    expect(formatCurrency(1234.5, 'GBP', { locale: 'en-GB' })).toContain('1,234.50');
    expect(formatPercent(0.455, { locale: 'en' })).toBe('45.5%');
  });

  it('joins a list the way the locale joins lists', () => {
    // Joining with ', ' in code is the small thing that makes a translated
    // screen read like a translated screen.
    expect(formatList(['a', 'b', 'c'], { locale: 'en' })).toBe('a, b, and c');
  });

  it('reuses formatters rather than building one per row', () => {
    resetFormatterCache();

    const first = formatDate(when, { locale: 'en', timeZone: 'UTC' });
    const second = formatDate(when, { locale: 'en', timeZone: 'UTC' });

    expect(first).toBe(second);
  });

  it('does not mix locales through the cache', () => {
    resetFormatterCache();

    const british = formatCurrency(10, 'GBP', { locale: 'en-GB' });
    const german = formatCurrency(10, 'EUR', { locale: 'de-DE' });

    expect(british).not.toBe(german);
  });
});
