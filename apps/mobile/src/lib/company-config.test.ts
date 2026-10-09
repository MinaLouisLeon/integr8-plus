import { describe, expect, it } from 'vitest';
import { companyIdentifiers, isCompanySlug, parseCompanyBuild } from './company-config';

describe('companyIdentifiers', () => {
  it('derives the slug, scheme and both store identifiers from the company slug', () => {
    expect(companyIdentifiers('northwind')).toEqual({
      slug: 'integr8-northwind',
      scheme: 'integr8-northwind',
      iosBundleIdentifier: 'com.integr8.plus.northwind',
      androidPackage: 'com.integr8.plus.northwind',
    });
  });

  it('keeps hyphens on iOS and turns them into underscores on Android', () => {
    const ids = companyIdentifiers('acme-facilities-ltd');
    expect(ids.iosBundleIdentifier).toBe('com.integr8.plus.acme-facilities-ltd');
    expect(ids.androidPackage).toBe('com.integr8.plus.acme_facilities_ltd');
  });

  it('prefixes an Android segment that starts with a digit', () => {
    expect(companyIdentifiers('7up-services').androidPackage).toBe(
      'com.integr8.plus.c7up_services',
    );
    // iOS accepts a leading digit; the bundle identifier is left as the slug.
    expect(companyIdentifiers('7up-services').iosBundleIdentifier).toBe(
      'com.integr8.plus.7up-services',
    );
  });

  it('refuses anything that is not a slug', () => {
    for (const bad of ['', 'Acme', 'acme_ltd', '-acme', 'acme-', 'acme--ltd', 'acme ltd', 'a.b']) {
      expect(() => companyIdentifiers(bad), bad).toThrow();
      expect(isCompanySlug(bad), bad).toBe(false);
    }
  });
});

describe('parseCompanyBuild', () => {
  const brand = {
    slug: 'northwind',
    name: 'Northwind Facilities',
    websiteUrl: 'https://northwind.example',
    brandColour: '#1d4ed8',
    shellColour: '#0f172a',
    defaultTheme: 'dark',
    logoPath: '/v1/public/companies/northwind/logo',
    appIconPath: '/v1/public/companies/northwind/app-icon',
  };

  it('accepts the brand endpoint answer as it is', () => {
    expect(parseCompanyBuild(brand)).toEqual(brand);
  });

  it('is undefined without a slug and a name', () => {
    expect(parseCompanyBuild(undefined)).toBeUndefined();
    expect(parseCompanyBuild(null)).toBeUndefined();
    expect(parseCompanyBuild('northwind')).toBeUndefined();
    expect(parseCompanyBuild({ ...brand, slug: 'Not A Slug' })).toBeUndefined();
    expect(parseCompanyBuild({ ...brand, name: '  ' })).toBeUndefined();
  });

  it('treats missing, empty and malformed brand values as absent', () => {
    expect(parseCompanyBuild({ slug: 'northwind', name: 'Northwind' })).toEqual({
      slug: 'northwind',
      name: 'Northwind',
      websiteUrl: null,
      brandColour: null,
      shellColour: null,
      defaultTheme: 'system',
      logoPath: null,
      appIconPath: null,
    });
    expect(
      parseCompanyBuild({ ...brand, websiteUrl: '', brandColour: 7, defaultTheme: 'sepia' }),
    ).toMatchObject({ websiteUrl: null, brandColour: null, defaultTheme: 'system' });
  });
});
