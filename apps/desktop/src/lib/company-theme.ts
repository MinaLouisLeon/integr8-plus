import { brandAccentVariables, brandShellVariables, type Theme } from '@integr8/tokens';
import { readStorage, removeStorage, writeStorage } from './preferences';

/**
 * The company's look, remembered between launches.
 *
 * Every company's app opens in that company's theme and colours, read from
 * `/v1/me` once there is a session. That request takes a moment, and a window
 * that paints light and then snaps dark is a window that looks broken — so the
 * theme and the brand are remembered here, and `main.tsx` paints from memory
 * before React renders. The sign-in screen reads the same memory, which is why
 * the second launch of a company's app already looks like that company before
 * anybody has signed in.
 *
 * Nothing here is a secret: a company's name, slug and colours are on its
 * public sign-in screen by design. Tokens live in the keychain (`platform.ts`).
 */

const THEME_KEY = 'integr8.companyTheme';
const BRAND_KEY = 'integr8.brand';

export type CompanyTheme = 'light' | 'dark' | 'system';

export const COMPANY_THEMES: readonly CompanyTheme[] = ['light', 'dark', 'system'];

export function isCompanyTheme(value: unknown): value is CompanyTheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Sets the theme on `<html>`; `system` removes the attribute so the media query decides. */
export function applyTheme(theme: CompanyTheme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.dataset.theme = theme;
  }
}

export function readCompanyTheme(): CompanyTheme | undefined {
  const stored = readStorage(THEME_KEY);
  return isCompanyTheme(stored) ? stored : undefined;
}

export function rememberCompanyTheme(theme: CompanyTheme): void {
  writeStorage(THEME_KEY, theme);
}

/** Paints the remembered theme, for the first frame of a launch. */
export function applyRememberedTheme(): void {
  const theme = readCompanyTheme();
  if (theme !== undefined) {
    applyTheme(theme);
  }
}

// ---------------------------------------------------------------------------
// The brand the sign-in screen wears
// ---------------------------------------------------------------------------

export interface RememberedBrand {
  name: string;
  slug: string;
  /** The public logo route, relative to the API; absent when the company has no logo. */
  logoPath?: string;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: CompanyTheme;
}

/** What `/v1/me` says about the company; the fields this module reads. */
export interface BrandSource {
  name: string;
  slug: string;
  logoMediaId: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: CompanyTheme;
}

export function toRememberedBrand(company: BrandSource): RememberedBrand {
  return {
    name: company.name,
    slug: company.slug,
    ...(company.logoMediaId === null
      ? {}
      : { logoPath: `/v1/public/companies/${encodeURIComponent(company.slug)}/logo` }),
    brandColour: company.brandColour,
    shellColour: company.shellColour,
    defaultTheme: company.defaultTheme,
  };
}

/**
 * The stored brand, or nothing when the entry is missing, malformed or from a
 * build that stored a different shape. Storage is writable by anything on the
 * origin, so every field is checked rather than trusted.
 */
export function parseRememberedBrand(raw: string | null | undefined): RememberedBrand | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.name !== 'string' || typeof value.slug !== 'string') {
    return undefined;
  }
  const colour = (field: unknown): string | null | undefined =>
    field === null ? null : typeof field === 'string' ? field : undefined;
  const brandColour = colour(value.brandColour);
  const shellColour = colour(value.shellColour);
  if (brandColour === undefined || shellColour === undefined) {
    return undefined;
  }
  if (!isCompanyTheme(value.defaultTheme)) {
    return undefined;
  }
  const logoPath = value.logoPath;
  if (logoPath !== undefined && (typeof logoPath !== 'string' || !logoPath.startsWith('/'))) {
    return undefined;
  }
  return {
    name: value.name,
    slug: value.slug,
    ...(typeof logoPath === 'string' ? { logoPath } : {}),
    brandColour,
    shellColour,
    defaultTheme: value.defaultTheme,
  };
}

export function readRememberedBrand(): RememberedBrand | undefined {
  return parseRememberedBrand(readStorage(BRAND_KEY));
}

export function rememberBrand(company: BrandSource): void {
  try {
    writeStorage(BRAND_KEY, JSON.stringify(toRememberedBrand(company)));
  } catch {
    // Nothing of value is lost: the next launch asks `/v1/me` as it always did.
  }
}

export function forgetBrand(): void {
  removeStorage(BRAND_KEY);
}

// ---------------------------------------------------------------------------
// The custom properties a brand sets on <html>
// ---------------------------------------------------------------------------

/** The accent and shell custom properties for a brand in a theme; empty when neither colour is set. */
export function brandVariables(
  brandColour: string | null,
  shellColour: string | null,
  theme: Theme,
): Record<string, string> {
  return {
    ...(brandColour === null ? {} : brandAccentVariables(brandColour, theme)),
    ...(shellColour === null ? {} : brandShellVariables(shellColour)),
  };
}

/** Sets the variables on `<html>` and returns the function that lifts them again. */
export function applyBrandVariables(variables: Record<string, string>): () => void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  return () => {
    for (const name of Object.keys(variables)) {
      root.style.removeProperty(name);
    }
  };
}
