import { describe, expect, it } from 'vitest';
import { type BrandSource, resolveBrandSource } from './brand-source';

const built: BrandSource = {
  name: 'Northwind (built)',
  slug: 'northwind',
  logoPath: '/v1/public/companies/northwind/logo',
  brandColour: '#111111',
  shellColour: null,
  defaultTheme: 'system',
  websiteUrl: 'https://old.northwind.example',
};
const cached: BrandSource = { ...built, name: 'Northwind (cached)', brandColour: '#222222' };
const signedIn = {
  name: 'Northwind (signed in)',
  slug: 'northwind',
  brandColour: '#333333',
  shellColour: '#0f172a',
  defaultTheme: 'dark' as const,
  websiteUrl: 'https://northwind.example',
  logoMediaId: 'logo-1',
};

describe('resolveBrandSource', () => {
  it('prefers the signed-in identity, then the cached brand, then the build', () => {
    expect(resolveBrandSource(signedIn, cached, built)?.name).toBe('Northwind (signed in)');
    expect(resolveBrandSource(undefined, cached, built)?.name).toBe('Northwind (cached)');
    expect(resolveBrandSource(undefined, undefined, built)?.name).toBe('Northwind (built)');
    expect(resolveBrandSource(undefined, undefined, undefined)).toBeUndefined();
  });

  it('carries the identity’s colours, theme and website, and its logo as the public path', () => {
    expect(resolveBrandSource(signedIn, cached, built)).toEqual({
      name: 'Northwind (signed in)',
      slug: 'northwind',
      logoPath: '/v1/public/companies/northwind/logo',
      brandColour: '#333333',
      shellColour: '#0f172a',
      defaultTheme: 'dark',
      websiteUrl: 'https://northwind.example',
    });
  });

  it('has no logo when the company has none, and borrows a slug from an older download', () => {
    expect(
      resolveBrandSource({ ...signedIn, logoMediaId: null }, cached, built)?.logoPath,
    ).toBeNull();
    expect(resolveBrandSource({ ...signedIn, slug: '' }, undefined, built)?.slug).toBe('northwind');
    expect(
      resolveBrandSource({ ...signedIn, slug: '' }, undefined, undefined)?.logoPath,
    ).toBeNull();
  });
});
