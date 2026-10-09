import {
  canOpenOffline,
  requiresSignIn,
  shouldRefresh,
  type StoredTokens,
  type TokenStore,
} from '@integr8/core';
import { ApiRequestError, createClient, type Integr8Client } from './index.js';

/**
 * The client wiring every app shares: tokens in, tokens out, and one refresh.
 *
 * P03 left `TokenStore` as a contract with an in-memory implementation, and P04
 * left `createClient` asking for a token it did not know how to get. This is
 * the piece between them, and it lives here rather than in each app because
 * getting it slightly wrong three times is how two of the three end up with a
 * refresh storm.
 *
 * What it is careful about:
 *
 * - **One refresh at a time.** Twenty requests hitting an expired token
 *   together must produce one refresh, not twenty — and nineteen of them must
 *   wait for it rather than each starting their own.
 * - **The refresh call does not go through the managed client.** It uses a bare
 *   `fetch`, or a 401 on the refresh endpoint would trigger a refresh, which
 *   would 401.
 * - **A dead refresh token signs the person out** rather than leaving the app
 *   retrying a credential that will never work again.
 * - **Only a refusal is dead.** A 502 from a proxy or a 503 during a deploy says
 *   nothing about the session. On a phone, signing out wipes the work stored on
 *   it (P11), so mistaking an outage for a revocation would destroy an
 *   engineer's unsent work because a load balancer restarted.
 */

/** What the refresh endpoint answers when the session is truly over. */
const DEAD_REFRESH_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

export interface SessionManagerOptions {
  baseUrl: string;
  clientApp: 'web' | 'desktop' | 'mobile';
  clientVersion: string;
  /** Where tokens live. The keychain, SecureStore, or a cookie-backed shim. */
  store: TokenStore;
  /** Called when the session ends and the person has to sign in again. */
  onSignedOut?: (reason: SignOutReason) => void;
  onClientTooOld?: (info: { minimum: string; message: string }) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export type SignOutReason =
  /** They asked. */
  | 'requested'
  /** The refresh token expired before the app was next opened. */
  | 'expired'
  /** The server rejected the refresh — revoked, reused, or the membership ended. */
  | 'rejected';

export interface SignInInput {
  email: string;
  password: string;
  tenantId?: string;
  /**
   * The company this app was built for, by short name. The API then signs in
   * only that company's people and answers 403 `wrong_company` to anybody
   * else, so one company's app can never show another's data.
   */
  companySlug?: string;
  deviceLabel?: string;
}

export interface Membership {
  tenantId: string;
  role: string;
  status: string;
}

export interface SignInResult {
  tenantId: string;
  userId: string;
  memberships: Membership[];
}

export interface TokenPayload {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export class SessionManager {
  readonly client: Integr8Client;

  readonly #options: SessionManagerOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  /** The in-flight refresh, if there is one. This is the single-flight latch. */
  #refreshing: Promise<string | null> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());

    this.client = createClient({
      baseUrl: options.baseUrl,
      clientApp: options.clientApp,
      clientVersion: options.clientVersion,
      getAccessToken: () => this.#accessTokenForRequest(),
      onUnauthorised: () => this.#refreshOnce(),
      ...(options.onClientTooOld === undefined ? {} : { onClientTooOld: options.onClientTooOld }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  // -------------------------------------------------------------------------
  // Signing in and out
  // -------------------------------------------------------------------------

  async signInWithPassword(input: SignInInput): Promise<SignInResult> {
    const response = await this.#post('/v1/auth/sign-in', {
      email: input.email,
      password: input.password,
      clientApp: this.#options.clientApp,
      ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
      ...(input.companySlug === undefined ? {} : { companySlug: input.companySlug }),
      ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
    });

    const body = (await this.#readOrThrow(response)) as {
      tokens: TokenPayload;
      tenantId: string;
      userId: string;
      memberships: Membership[];
    };

    await this.#options.store.write(toStoredTokens(body.tokens));

    return { tenantId: body.tenantId, userId: body.userId, memberships: body.memberships };
  }

  async requestMagicLink(email: string, redirectTo: string): Promise<void> {
    const response = await this.#post('/v1/auth/magic-link', { email, redirectTo });
    await this.#readOrThrow(response);
  }

  /**
   * Ends the session on the server, then locally.
   *
   * The local clear happens even if the server call fails. Somebody who taps
   * "sign out" on a train with no signal has ended their session as far as they
   * are concerned, and leaving a usable token on the device would be the wrong
   * way to disagree.
   */
  async signOut(): Promise<void> {
    try {
      await this.client.POST('/v1/auth/sign-out', { body: { everywhere: false } });
    } catch {
      // Deliberately swallowed; see above.
    }

    await this.#options.store.clear();
    this.#options.onSignedOut?.('requested');
  }

  /** Moves to another of this person's companies and stores the new tokens. */
  async switchTenant(tenantId: string): Promise<SignInResult> {
    const { data, error } = await this.client.POST('/v1/auth/switch-tenant', {
      body: { tenantId, clientApp: this.#options.clientApp },
    });

    if (error !== undefined || data === undefined) {
      throw new ApiRequestError(400, 'switch_failed', 'Could not switch company.', '');
    }

    const body = data as unknown as {
      tokens: TokenPayload;
      tenantId: string;
      userId: string;
      memberships: Membership[];
    };

    await this.#options.store.write(toStoredTokens(body.tokens));

    return { tenantId: body.tenantId, userId: body.userId, memberships: body.memberships };
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * Takes over a session minted somewhere else.
   *
   * The one caller is the desktop app's staff sign-in: a super admin signs in
   * to the platform, asks to act as a company, and the API answers with a
   * tenant session that carries the impersonation claim. From here on it is an
   * ordinary session — refreshed, revoked and signed out like any other — and
   * the banner comes from `/v1/me`, not from anything remembered here.
   */
  async adoptTokens(tokens: TokenPayload): Promise<void> {
    await this.#options.store.write(toStoredTokens(tokens));
  }

  async isSignedIn(): Promise<boolean> {
    const tokens = await this.#options.store.read();
    if (tokens === undefined) {
      return false;
    }

    // A device with a live offline grant counts as signed in even when its
    // refresh token has lapsed — that is the whole point of the grant, and the
    // app has to open in a basement.
    return !requiresSignIn(tokens, this.#now()) || canOpenOffline(tokens, this.#now());
  }

  /**
   * True when a request could be authenticated: there is a refresh token that has
   * not expired.
   *
   * A phone opened on its offline grant alone must not try: the attempt would
   * find the refresh token expired and end the session — grant included —
   * before sending anything. Background work checks this first and leaves the
   * engineer on their downloaded jobs.
   */
  async canReachApi(): Promise<boolean> {
    const tokens = await this.#options.store.read();
    return tokens !== undefined && !requiresSignIn(tokens, this.#now());
  }

  /** True when the app may open on cached work with no network at all. */
  async canWorkOffline(): Promise<boolean> {
    const tokens = await this.#options.store.read();
    return tokens !== undefined && canOpenOffline(tokens, this.#now());
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The token to send, refreshing first if it is about to expire.
   *
   * Refreshing a minute early costs one round trip; not doing so costs a failed
   * request and a retry on a connection that may already be marginal.
   */
  async #accessTokenForRequest(): Promise<string | null> {
    const tokens = await this.#options.store.read();
    if (tokens === undefined) {
      return null;
    }

    if (!shouldRefresh(tokens, this.#now())) {
      return tokens.accessToken;
    }

    if (requiresSignIn(tokens, this.#now())) {
      await this.#endSession('expired');
      return null;
    }

    return this.#refreshOnce();
  }

  /**
   * Refreshes, or joins the refresh already running.
   *
   * The latch is set before the first `await`, so two callers arriving in the
   * same tick cannot both see it empty.
   */
  async #refreshOnce(): Promise<string | null> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });

    return this.#refreshing;
  }

  async #refresh(): Promise<string | null> {
    const tokens = await this.#options.store.read();
    if (tokens === undefined) {
      return null;
    }

    // A bare fetch, not the managed client: a 401 here would otherwise trigger
    // a refresh, which would 401.
    const response = await this.#post('/v1/auth/refresh', {
      refreshToken: tokens.refreshToken,
    });

    if (!response.ok) {
      if (DEAD_REFRESH_STATUSES.has(response.status)) {
        // Revoked, reused, or the membership ended. None of those is retriable,
        // and holding the token would leave the app trying a credential that
        // will never work again.
        await this.#endSession('rejected');
        return null;
      }
      // Anything else is the server, or something in front of it, failing. The
      // session is kept, and the request that needed it fails with the reason.
      throw new ApiRequestError(
        response.status,
        'refresh_unavailable',
        'The session could not be renewed just now. Try again shortly.',
        response.headers.get('x-request-id') ?? '',
      );
    }

    const refreshed = (await response.json()) as TokenPayload;
    const stored = toStoredTokens(refreshed, tokens);
    await this.#options.store.write(stored);

    return stored.accessToken;
  }

  async #endSession(reason: SignOutReason): Promise<void> {
    await this.#options.store.clear();
    this.#options.onSignedOut?.(reason);
  }

  #post(path: string, body: unknown): Promise<Response> {
    return this.#fetch(`${this.#options.baseUrl.replace(/\/+$/u, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-app': this.#options.clientApp,
        'x-client-version': this.#options.clientVersion,
      },
      body: JSON.stringify(body),
    });
  }

  async #readOrThrow(response: Response): Promise<unknown> {
    if (response.ok) {
      return response.status === 204 ? {} : response.json();
    }

    let code = 'unknown_error';
    let message = `The request failed with status ${String(response.status)}.`;
    let requestId = response.headers.get('x-request-id') ?? '';

    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; requestId?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      requestId = body.error?.requestId ?? requestId;
    } catch {
      // A proxy can answer with HTML. Falling back to the status is better than
      // failing while reporting a failure.
    }

    if (code === 'client_too_old') {
      this.#options.onClientTooOld?.({
        minimum: response.headers.get('min-supported-client') ?? '',
        message,
      });
    }

    throw new ApiRequestError(response.status, code, message, requestId);
  }
}

/**
 * Keeps the offline grant across a refresh.
 *
 * The refresh endpoint returns an access and a refresh token; it says nothing
 * about the grant, which was issued separately and outlives both. Dropping it
 * here would silently disable offline working on the next refresh — a bug that
 * would only appear to somebody who then lost signal.
 */
function toStoredTokens(payload: TokenPayload, previous?: StoredTokens): StoredTokens {
  return {
    accessToken: payload.accessToken,
    accessTokenExpiresAt: new Date(payload.accessTokenExpiresAt),
    refreshToken: payload.refreshToken,
    refreshTokenExpiresAt: new Date(payload.refreshTokenExpiresAt),
    ...(previous?.offlineGrant === undefined
      ? {}
      : {
          offlineGrant: previous.offlineGrant,
          offlineGrantExpiresAt: previous.offlineGrantExpiresAt,
        }),
  };
}
