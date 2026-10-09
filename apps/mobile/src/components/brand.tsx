import { identity } from '@integr8/offline';
import { brandAccent, type BrandAccent, brandShell, type BrandShell } from '@integr8/tokens';
import { createContext, useContext, type ReactNode, useSyncExternalStore } from 'react';
import { useColorScheme } from 'react-native';
import { cachedBrand, subscribeBrand } from '~/lib/brand-cache';
import { resolveBrandSource } from '~/lib/brand-source';
import { COMPANY, publicUrl } from '~/lib/company';
import type { CompanyTheme } from '~/lib/company-config';
import { API_BASE_URL } from '~/lib/env';
import { useLocalQuery } from '~/local/react';

/**
 * The company's brand on the phone.
 *
 * Three places can know it, and the freshest wins:
 *
 * 1. **The signed-in identity** — the phone's own `meta` table, where the last
 *    download left the company's name and colours, so the app wears the brand
 *    in a basement with no signal exactly as it does in the office.
 * 2. **The cached public brand** — what the brand endpoint answered the last
 *    time this phone launched with signal (`brand-cache.ts`). It covers the
 *    welcome and sign-in screens, where nobody is signed in yet.
 * 3. **The company baked in at build time** — `COMPANY`, so a company's app is
 *    never unbranded, not even on first launch in a basement.
 *
 * The generic app, signed out, has none of these and wears Integr8's own colours.
 * `useTheme` merges the accent and shell from here; a screen that wants the
 * name or the logo asks for it.
 */

export interface Brand {
  name: string;
  slug: string;
  /** The company's public logo, or null when it has none. */
  logoUrl: string | null;
  /** Null when the company has no colour, or nothing is known yet. */
  accent: BrandAccent | null;
  /** The six shell tokens for the company's shell colour, or null for the default. */
  shell: BrandShell | null;
  defaultTheme: CompanyTheme;
  websiteUrl: string | null;
}

const NONE: Brand = {
  name: '',
  slug: '',
  logoUrl: null,
  accent: null,
  shell: null,
  defaultTheme: 'system',
  websiteUrl: null,
};

const BrandContext = createContext<Brand>(NONE);

export function BrandProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const me = useLocalQuery('identity', ['meta'], identity);
  const company = me.status === 'ready' ? me.data?.company : undefined;
  const cached = useSyncExternalStore(subscribeBrand, cachedBrand, cachedBrand);

  const source = resolveBrandSource(company, cached, COMPANY);
  const theme =
    source?.defaultTheme === 'light' || source?.defaultTheme === 'dark'
      ? source.defaultTheme
      : scheme;

  const brand: Brand =
    source === undefined
      ? NONE
      : {
          name: source.name,
          slug: source.slug,
          logoUrl: publicUrl(API_BASE_URL, source.logoPath),
          accent: source.brandColour === null ? null : brandAccent(source.brandColour, theme),
          shell: source.shellColour === null ? null : brandShell(source.shellColour),
          defaultTheme: source.defaultTheme,
          websiteUrl: source.websiteUrl,
        };

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}
