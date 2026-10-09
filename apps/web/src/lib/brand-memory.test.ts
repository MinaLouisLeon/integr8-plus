import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND_STORAGE_KEY, publicLogoUrl, recallBrand, rememberBrand } from './brand-memory';

/**
 * The sign-in page reads this before anybody is signed in, so whatever is in
 * storage — stale, hand-edited, or from a build that stored something else —
 * must come back as a brand or as nothing, never as an exception.
 */
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    store,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remembering the brand', () => {
  it('round-trips what the shell learned', () => {
    const storage = fakeStorage();
    vi.stubGlobal('window', { localStorage: storage });
    rememberBrand({
      name: 'Acme',
      logoUrl: 'https://api.example/v1/public/companies/acme/logo',
      brandColour: '#1d4ed8',
      shellColour: null,
      defaultTheme: 'dark',
    });
    expect(recallBrand()).toEqual({
      name: 'Acme',
      logoUrl: 'https://api.example/v1/public/companies/acme/logo',
      brandColour: '#1d4ed8',
      shellColour: null,
      defaultTheme: 'dark',
    });
  });

  it('returns nothing for garbage, and nothing when storage throws', () => {
    vi.stubGlobal('window', {
      localStorage: fakeStorage({ [BRAND_STORAGE_KEY]: '{not json' }),
    });
    expect(recallBrand()).toBeNull();

    vi.stubGlobal('window', {
      localStorage: fakeStorage({ [BRAND_STORAGE_KEY]: JSON.stringify({ logoUrl: 'x' }) }),
    });
    expect(recallBrand()).toBeNull();

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(recallBrand()).toBeNull();
    expect(() =>
      rememberBrand({
        name: 'Acme',
        logoUrl: null,
        brandColour: null,
        shellColour: null,
        defaultTheme: 'system',
      }),
    ).not.toThrow();
  });

  it('defaults an unknown theme to the system one', () => {
    vi.stubGlobal('window', {
      localStorage: fakeStorage({
        [BRAND_STORAGE_KEY]: JSON.stringify({ name: 'Acme', defaultTheme: 'sepia' }),
      }),
    });
    expect(recallBrand()?.defaultTheme).toBe('system');
  });

  it('builds the public logo link against the API, slug escaped', () => {
    expect(publicLogoUrl('acme co')).toMatch(/\/v1\/public\/companies\/acme%20co\/logo$/u);
  });
});
