import { describe, expect, it } from 'vitest';
import { brandVariables, parseRememberedBrand, toRememberedBrand } from './company-theme';

/**
 * The brand the sign-in screen wears comes out of `localStorage`, which
 * anything on the origin can write. So the parser trusts nothing: a field of
 * the wrong type is a brand to forget, not a brand to half-wear.
 */

const company = {
  name: 'Acme Lifts',
  slug: 'acme-lifts',
  logoMediaId: '8f1c2a4e-0000-4000-8000-000000000001',
  brandColour: '#0f766e',
  shellColour: '#134e4a',
  defaultTheme: 'dark' as const,
};

describe('remembering a brand', () => {
  it('stores the public logo route only when there is a logo', () => {
    expect(toRememberedBrand(company)).toEqual({
      name: 'Acme Lifts',
      slug: 'acme-lifts',
      logoPath: '/v1/public/companies/acme-lifts/logo',
      brandColour: '#0f766e',
      shellColour: '#134e4a',
      defaultTheme: 'dark',
    });
    expect(toRememberedBrand({ ...company, logoMediaId: null })).not.toHaveProperty('logoPath');
  });

  it('reads back what it wrote', () => {
    const stored = JSON.stringify(toRememberedBrand(company));
    expect(parseRememberedBrand(stored)).toEqual(toRememberedBrand(company));
  });

  it('forgets anything malformed', () => {
    expect(parseRememberedBrand(null)).toBeUndefined();
    expect(parseRememberedBrand('')).toBeUndefined();
    expect(parseRememberedBrand('not json')).toBeUndefined();
    expect(parseRememberedBrand('[]')).toBeUndefined();
    expect(parseRememberedBrand(JSON.stringify({ name: 'x' }))).toBeUndefined();
    expect(
      parseRememberedBrand(JSON.stringify({ ...toRememberedBrand(company), defaultTheme: 'neon' })),
    ).toBeUndefined();
    expect(
      parseRememberedBrand(JSON.stringify({ ...toRememberedBrand(company), brandColour: 7 })),
    ).toBeUndefined();
    // A logo path that is not a path on our API is not followed.
    expect(
      parseRememberedBrand(
        JSON.stringify({ ...toRememberedBrand(company), logoPath: 'https://elsewhere/x.png' }),
      ),
    ).toBeUndefined();
  });
});

describe('the variables a brand sets', () => {
  it('sets accent and shell tokens together, and neither when there is no colour', () => {
    const both = brandVariables('#0f766e', '#134e4a', 'light');
    expect(both['--colour-accent']).toBe('#0f766e');
    expect(both['--colour-shell']).toBe('#134e4a');

    const accentOnly = brandVariables('#0f766e', null, 'light');
    expect(accentOnly).toHaveProperty('--colour-accent');
    expect(accentOnly).not.toHaveProperty('--colour-shell');

    expect(brandVariables(null, null, 'dark')).toEqual({});
  });

  it('ignores a value that is not a colour', () => {
    expect(brandVariables('teal', 'not-a-colour', 'light')).toEqual({});
  });
});
