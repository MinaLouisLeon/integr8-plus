import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * English first (Low 3): the locale is the remembered choice, and without one
 * it is English, whatever language the browser asks for.
 */

const store = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = store.cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
  // An Arabic browser. Reading this would make the first test fail.
  headers: () => Promise.resolve(new Headers({ 'accept-language': 'ar-EG,ar;q=0.9,en;q=0.5' })),
}));

const { LOCALE_COOKIE, readPreferences, resolveLocale } = await import('./preferences');

describe('the locale', () => {
  beforeEach(() => {
    store.cookies.clear();
  });

  it('is English when nothing was chosen, even for an Arabic browser', async () => {
    const preferences = await readPreferences();
    expect(preferences.locale).toBe('en');
    expect(preferences.direction).toBe('ltr');
  });

  it('is Arabic, right to left, once Arabic was chosen', async () => {
    store.cookies.set(LOCALE_COOKIE, 'ar');
    const preferences = await readPreferences();
    expect(preferences.locale).toBe('ar');
    expect(preferences.direction).toBe('rtl');
  });

  it('stays English when English was chosen', async () => {
    store.cookies.set(LOCALE_COOKIE, 'en');
    expect((await readPreferences()).locale).toBe('en');
  });

  it('ignores a cookie that names no language this product has', () => {
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });
});
