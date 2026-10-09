import { File, Paths } from 'expo-file-system';
import { COMPANY } from './company';
import { type CompanyBuild, parseCompanyBuild } from './company-config';
import { API_BASE_URL } from './env';
import { APP_VERSION } from './session';

/**
 * The company's public brand, kept on the phone.
 *
 * A company build wears its brand before anybody signs in, and the brand baked
 * in at build time goes stale the day the owner changes a colour. So on launch
 * the app asks the public brand endpoint — no session needed — and keeps the
 * answer in `brand.json` in the document directory, where the next launch reads
 * it with no signal at all. A failure is ignored: the baked brand is still here.
 *
 * Kept outside React, like `localData`, so the welcome screen and the theme
 * read one value through `useSyncExternalStore`.
 */

const FILE_NAME = 'brand.json';

let cached: CompanyBuild | undefined;
let loaded = false;
const listeners = new Set<() => void>();

function file(): File {
  return new File(Paths.document, FILE_NAME);
}

function publish(next: CompanyBuild | undefined): void {
  cached = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last public brand answer this phone kept, if any. */
export function cachedBrand(): CompanyBuild | undefined {
  return cached;
}

/** Reads `brand.json` once. A missing or unreadable file is simply no cache. */
export async function loadCachedBrand(): Promise<CompanyBuild | undefined> {
  if (loaded) {
    return cached;
  }
  loaded = true;
  try {
    const stored = file();
    if (stored.exists) {
      const parsed = parseCompanyBuild(JSON.parse(await stored.text()));
      // A cache for another company — a developer switching company.json — is ignored.
      if (parsed !== undefined && (COMPANY === undefined || parsed.slug === COMPANY.slug)) {
        publish(parsed);
      }
    }
  } catch {
    // Treated as no cache; the next successful fetch rewrites it.
  }
  return cached;
}

/**
 * Fetches the public brand for the built-in company and keeps it. Nothing
 * happens in the generic app, and nothing is thrown: no signal, a server that is
 * down and a malformed answer all leave the brand the phone already has.
 */
export async function refreshBrand(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (COMPANY === undefined) {
    return;
  }
  await loadCachedBrand();
  try {
    const url = `${API_BASE_URL}/v1/public/companies/${encodeURIComponent(COMPANY.slug)}/brand`;
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'x-client-app': 'mobile',
        'x-client-version': APP_VERSION,
      },
    });
    if (!response.ok) {
      return;
    }
    const brand = parseCompanyBuild(await response.json());
    if (brand?.slug !== COMPANY.slug) {
      return;
    }
    publish(brand);
    try {
      file().write(JSON.stringify(brand));
    } catch {
      // The brand is in memory for this run; a cache that cannot be written is not an error.
    }
  } catch {
    // Offline, or the API is unreachable: the baked or cached brand stays.
  }
}

/** Forgets the cached brand. Used by tests and by nothing on the phone: the brand is public. */
export function clearBrandCache(): void {
  loaded = false;
  publish(undefined);
}
