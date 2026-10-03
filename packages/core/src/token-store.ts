/**
 * Where a client keeps its tokens.
 *
 * The interface lives here, with no implementation that touches a real store,
 * because the right store is different on every client and none of them exist
 * yet — P05 builds the shells. What exists now is the contract they will
 * implement and the tests that contract has to satisfy, so that P05 is wiring
 * rather than designing.
 *
 * | Client  | Implementation                                    |
 * | ------- | ------------------------------------------------- |
 * | desktop | Tauri's OS keychain plugin (Keychain / DPAPI)     |
 * | mobile  | Expo SecureStore (Keychain / EncryptedSharedPrefs) |
 * | web     | An httpOnly cookie set by the API; never JS-readable |
 *
 * **Not `localStorage`, on any client.** Any script on the page can read it,
 * which turns one cross-site scripting bug into every customer's data. This is
 * a task in P03 for that reason, and the reason is worth stating where somebody
 * about to take the convenient path will read it.
 */

export interface StoredTokens {
  /** Short-lived, sent on every request. */
  accessToken: string;
  /** Opaque, single-use, exchanged for a new pair. */
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  /** Present on mobile only: lets the app open without a network. */
  offlineGrant?: string | undefined;
  offlineGrantExpiresAt?: Date | undefined;
}

export interface TokenStore {
  read: () => Promise<StoredTokens | undefined>;
  write: (tokens: StoredTokens) => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * A store that keeps tokens in memory for the life of the process.
 *
 * Correct for tests and for the API's own outbound calls. Wrong for any client
 * that should survive a restart — which is all of them — so it is named to make
 * an accidental production use obvious in a diff.
 */
export class InMemoryTokenStore implements TokenStore {
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

/** How long before expiry a client should refresh rather than wait to be rejected. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * True when the access token should be refreshed now.
 *
 * The margin exists because a token that is valid when the request is composed
 * can be expired by the time it arrives. Refreshing a minute early costs one
 * round trip; not doing so costs a failed request and a retry on a connection
 * that may already be marginal.
 */
export function shouldRefresh(
  tokens: StoredTokens,
  now: Date = new Date(),
  marginMs: number = ACCESS_TOKEN_REFRESH_MARGIN_MS,
): boolean {
  return tokens.accessTokenExpiresAt.getTime() - now.getTime() <= marginMs;
}

/** True when the refresh token has expired and the person has to sign in again. */
export function requiresSignIn(tokens: StoredTokens, now: Date = new Date()): boolean {
  return tokens.refreshTokenExpiresAt.getTime() <= now.getTime();
}

/**
 * True when the app may open using its offline grant.
 *
 * Distinct from {@link requiresSignIn}: an engineer in a basement has an
 * expired access token and an unusable refresh token, and must still be able to
 * work. The grant is what says they may.
 */
export function canOpenOffline(tokens: StoredTokens, now: Date = new Date()): boolean {
  return (
    tokens.offlineGrant !== undefined &&
    tokens.offlineGrantExpiresAt !== undefined &&
    tokens.offlineGrantExpiresAt.getTime() > now.getTime()
  );
}
