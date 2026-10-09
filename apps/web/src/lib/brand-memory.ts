/**
 * The company's look, remembered for the sign-in page.
 *
 * Nobody is signed in on the sign-in page, so it cannot ask `/v1/me` whose
 * company this is. What it can do is remember what the last signed-in session
 * learned — the name, the public logo link and the colours — so from the second
 * visit the screen looks like the company's rather than the product's.
 *
 * `localStorage` holds no secret here: a name and a colour are what the
 * company's website shows anybody. Every access is wrapped, because storage
 * can be blocked, full, or absent in a private window, and a sign-in page that
 * crashes over a cosmetic memory is a sign-in page nobody can use.
 */

export const BRAND_STORAGE_KEY = 'integr8.brand';

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface RememberedBrand {
  name: string;
  /** The public logo link, which needs no session. Null when the company has no logo. */
  logoUrl: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: ThemeChoice;
}

function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/u, '');
}

/**
 * Where the company's logo can be fetched without a session. The signed media
 * link `/v1/me` leads to lasts minutes, so it is useless to remember; this
 * redirects to a fresh one every time.
 */
export function publicLogoUrl(slug: string): string {
  return `${apiBase()}/v1/public/companies/${encodeURIComponent(slug)}/logo`;
}

export function rememberBrand(brand: RememberedBrand): void {
  try {
    window.localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(brand));
  } catch {
    // Storage blocked or full: the sign-in page shows the product's look.
  }
}

export function forgetBrand(): void {
  try {
    window.localStorage.removeItem(BRAND_STORAGE_KEY);
  } catch {
    // Nothing to forget, or nowhere it could have been kept.
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(BRAND_STORAGE_KEY);
  } catch {
    return null;
  }
}

function isTheme(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** What was remembered, or null when nothing was or it does not read as a brand. */
export function recallBrand(): RememberedBrand | null {
  return parseBrand(readRaw());
}

/** The stored text, read as a brand. Exported for `useRememberedBrand`, which caches by text. */
export function parseBrand(raw: string | null): RememberedBrand | null {
  try {
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name === '') {
      return null;
    }
    return {
      name: record.name,
      logoUrl: optionalString(record.logoUrl),
      brandColour: optionalString(record.brandColour),
      shellColour: optionalString(record.shellColour),
      defaultTheme: isTheme(record.defaultTheme) ? record.defaultTheme : 'system',
    };
  } catch {
    return null;
  }
}

/**
 * The stored text, as an external store: `null` on the server and in the first
 * client render, so hydration agrees, then whatever the browser has. Text
 * rather than the parsed object, because a snapshot must be stable between
 * reads and two parses of one string are two objects.
 */
export function rememberedBrandSnapshot(): string | null {
  return readRaw();
}

export function subscribeToRememberedBrand(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === BRAND_STORAGE_KEY) {
      notify();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
  };
}
