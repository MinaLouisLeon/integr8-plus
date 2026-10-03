import { negotiateLocale } from '@integr8/i18n/core';
import { describe, expect, it } from 'vitest';
import { acceptedLanguages } from './preferences';

/**
 * Parsing `Accept-Language` is the one piece of `preferences.ts` that is worth
 * testing on its own: the rest is cookie reads, and getting the quality
 * ordering wrong shows somebody the wrong language without ever erroring.
 */
describe('Accept-Language', () => {
  it('orders by quality, best first', () => {
    expect(acceptedLanguages('en;q=0.5,ar;q=0.9')).toEqual(['ar', 'en']);
  });

  it('treats a tag with no quality as the most preferred', () => {
    expect(acceptedLanguages('en-GB,en;q=0.9,ar;q=0.8')).toEqual(['en-GB', 'en', 'ar']);
  });

  it('tolerates whitespace and empty entries', () => {
    expect(acceptedLanguages(' en-GB , , ar ')).toEqual(['en-GB', 'ar']);
  });

  it('returns nothing when the header is absent', () => {
    expect(acceptedLanguages(null)).toEqual([]);
  });

  it('feeds the negotiator, which matches on language and ignores region', () => {
    expect(negotiateLocale(acceptedLanguages('ar-EG,en;q=0.5'))).toBe('ar');
    expect(negotiateLocale(acceptedLanguages('fr-FR,de;q=0.5'))).toBe('en');
  });
});
