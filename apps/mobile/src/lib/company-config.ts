/**
 * A company's build: what CI writes to `company.json` before `eas build`, and
 * what the app finds again in `Constants.expoConfig.extra.company`.
 *
 * Plain TypeScript with no React Native in it: `app.config.ts` runs this in
 * Node when Expo resolves the config, and the running app reads the same shape
 * back. The identifier rules live here so one test covers both.
 */

export type CompanyTheme = 'light' | 'dark' | 'system';

/** Exactly the answer of `GET /v1/public/companies/{slug}/brand`. */
export interface CompanyBuild {
  slug: string;
  name: string;
  websiteUrl: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: CompanyTheme;
  /** Relative to the API base; the API redirects to the image. */
  logoPath: string | null;
  appIconPath: string | null;
}

/**
 * The EAS project's slug. EAS refuses a build whose slug is not the one of the
 * project named by `extra.eas.projectId`, and every company's app is built in
 * that one project, so the slug never changes per company. Nobody sees it:
 * the name, icon and store identifiers are what make the app the company's.
 */
export const EAS_PROJECT_SLUG = 'integr8-plus';

export interface CompanyIdentifiers {
  /** The Expo project slug: always {@link EAS_PROJECT_SLUG}. */
  slug: string;
  /** The deep-link scheme, `integr8-<slug>`, so two companies' apps never claim each other's links. */
  scheme: string;
  /** `com.integr8.plus.<slug>`: hyphens are legal in a bundle identifier. */
  iosBundleIdentifier: string;
  /**
   * `com.integr8.plus.<slug>` with every hyphen turned into an underscore, and
   * a `c` in front of a segment that starts with a digit: a Java package
   * segment is an identifier, so `7up` is not one and `c7up` is.
   */
  androidPackage: string;
}

/** A company slug as the API issues them: lower-case letters, digits and hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isCompanySlug(value: string): boolean {
  return SLUG.test(value);
}

export function companyIdentifiers(slug: string): CompanyIdentifiers {
  if (!isCompanySlug(slug)) {
    throw new Error(`"${slug}" is not a company slug (lower-case letters, digits and hyphens).`);
  }
  const androidSegment = slug.replaceAll('-', '_');
  return {
    slug: EAS_PROJECT_SLUG,
    scheme: `integr8-${slug}`,
    iosBundleIdentifier: `com.integr8.plus.${slug}`,
    androidPackage: `com.integr8.plus.${/^\d/u.test(androidSegment) ? `c${androidSegment}` : androidSegment}`,
  };
}

const THEMES: readonly CompanyTheme[] = ['light', 'dark', 'system'];

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Reads a company out of untrusted JSON: the file CI wrote, or the `extra`
 * block of a config built from it. Anything without a slug and a name is not a
 * company, and a brand value of the wrong shape is simply absent.
 */
export function parseCompanyBuild(value: unknown): CompanyBuild | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!isCompanySlug(slug) || name === '') {
    return undefined;
  }
  const theme = record.defaultTheme;
  return {
    slug,
    name,
    websiteUrl: optionalString(record.websiteUrl),
    brandColour: optionalString(record.brandColour),
    shellColour: optionalString(record.shellColour),
    defaultTheme: THEMES.find((candidate) => candidate === theme) ?? 'system',
    logoPath: optionalString(record.logoPath),
    appIconPath: optionalString(record.appIconPath),
  };
}
