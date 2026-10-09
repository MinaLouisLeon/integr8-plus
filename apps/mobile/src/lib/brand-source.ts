import type { CompanyTheme } from './company-config';

/**
 * The brand precedence, without React: the signed-in identity (freshest), then
 * the cached public brand, then the company baked in at build time. See
 * `components/brand.tsx` for why in that order.
 */

/** The public logo of a company, from its slug: the path the brand endpoint answers with. */
export function publicLogoPath(slug: string): string {
  return `/v1/public/companies/${slug}/logo`;
}

/** Which of the three sources answers, before the colours are turned into tokens. */
export interface BrandSource {
  name: string;
  slug: string;
  logoPath: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: CompanyTheme;
  websiteUrl: string | null;
}

export function resolveBrandSource(
  signedIn:
    | {
        name: string;
        slug: string;
        brandColour: string | null;
        shellColour: string | null;
        defaultTheme: CompanyTheme;
        websiteUrl: string | null;
        logoMediaId: string | null;
      }
    | undefined,
  cached: BrandSource | undefined,
  built: BrandSource | undefined,
): BrandSource | undefined {
  if (signedIn !== undefined) {
    // A download made before the slug joined the snapshot has no slug; the
    // public logo path needs one, so the other sources lend theirs.
    const slug = signedIn.slug !== '' ? signedIn.slug : (cached?.slug ?? built?.slug ?? '');
    return {
      name: signedIn.name,
      slug,
      logoPath: signedIn.logoMediaId === null || slug === '' ? null : publicLogoPath(slug),
      brandColour: signedIn.brandColour,
      shellColour: signedIn.shellColour,
      defaultTheme: signedIn.defaultTheme,
      websiteUrl: signedIn.websiteUrl,
    };
  }
  return cached ?? built;
}
