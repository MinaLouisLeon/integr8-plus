import type { StoredTokens, TokenStore } from '@integr8/core';

/**
 * The one file that knows whether this is a Tauri window or a browser tab.
 *
 * P05's second exit criterion is that the desktop app runs identically in both.
 * Keeping the difference to a single runtime check — rather than a build flag —
 * is what makes that testable: there is one bundle, and the browser path is
 * exercised every time anybody runs `pnpm dev`.
 */

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

/** True when running inside the Tauri shell rather than a browser tab. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && (window as TauriGlobal).__TAURI_INTERNALS__ !== undefined;
}

/**
 * Tokens in the operating system's credential store.
 *
 * Keychain on macOS, Credential Manager on Windows, Secret Service on Linux —
 * reached through a Rust command in `src-tauri`, because the `keyring` crate
 * knows all three and the web platform knows none of them.
 *
 * This is the reason the desktop app is not just a browser tab: a refresh token
 * that survives a restart has to live somewhere the operating system protects,
 * and in a browser there is no such place.
 */
export class KeychainTokenStore implements TokenStore {
  async read(): Promise<StoredTokens | undefined> {
    const { invoke } = await import('@tauri-apps/api/core');
    const stored = await invoke<string | null>('keychain_read');

    if (stored === null || stored === '') {
      return undefined;
    }

    try {
      return revive(JSON.parse(stored) as SerialisedTokens);
    } catch {
      // Corrupt or from an older format. Treat it as signed out rather than
      // crashing on launch; the person signs in again and the entry is
      // replaced.
      await this.clear();
      return undefined;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('keychain_write', { value: JSON.stringify(serialise(tokens)) });
  }

  async clear(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('keychain_clear');
  }
}

/**
 * Tokens for the life of the tab, and no longer.
 *
 * Used when the same bundle is opened in a browser. A reload signs the person
 * out, which is worse than the Tauri experience and better than the
 * alternative: `localStorage` is readable by any script on the page, which
 * turns one cross-site scripting bug into every customer's data.
 */
export class MemoryTokenStore implements TokenStore {
  #tokens: StoredTokens | undefined;

  read(): Promise<StoredTokens | undefined> {
    return Promise.resolve(this.#tokens);
  }

  write(tokens: StoredTokens): Promise<void> {
    this.#tokens = { ...tokens };
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#tokens = undefined;
    return Promise.resolve();
  }
}

/** The right store for wherever this bundle is running. */
export function createTokenStore(): TokenStore {
  return isTauri() ? new KeychainTokenStore() : new MemoryTokenStore();
}

interface SerialisedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  offlineGrant?: string | undefined;
  offlineGrantExpiresAt?: string | undefined;
}

/** `Date` does not survive `JSON.stringify` as a `Date`. */
function serialise(tokens: StoredTokens): SerialisedTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    ...(tokens.offlineGrant === undefined
      ? {}
      : {
          offlineGrant: tokens.offlineGrant,
          offlineGrantExpiresAt: tokens.offlineGrantExpiresAt?.toISOString(),
        }),
  };
}

function revive(stored: SerialisedTokens): StoredTokens {
  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    accessTokenExpiresAt: new Date(stored.accessTokenExpiresAt),
    refreshTokenExpiresAt: new Date(stored.refreshTokenExpiresAt),
    ...(stored.offlineGrant === undefined
      ? {}
      : {
          offlineGrant: stored.offlineGrant,
          offlineGrantExpiresAt:
            stored.offlineGrantExpiresAt === undefined
              ? undefined
              : new Date(stored.offlineGrantExpiresAt),
        }),
  };
}
