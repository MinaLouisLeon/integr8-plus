import { InMemoryTokenStore, type StoredTokens } from '@integr8/core';
import { describe, expect, it } from 'vitest';
import { SessionManager, type SignOutReason } from './session.js';

/**
 * The session manager's job is to make one refresh happen when twenty requests
 * discover an expired token at once, and to hand the person back to the sign-in
 * screen when the refresh is genuinely dead. Both are easy to get subtly wrong
 * and neither shows up until an app is under load or a token has been revoked.
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000),
    ...overrides,
  };
}

interface Harness {
  manager: SessionManager;
  store: InMemoryTokenStore;
  calls: string[];
  signOuts: SignOutReason[];
}

/**
 * The stub server sees the request, not just its URL.
 *
 * It has to: several of these tests turn on what happens when a request goes
 * out with no token, and a stub that answers 200 regardless would let a broken
 * refresh look like a working one.
 */
function harness(handler: (request: Request, call: number) => Response): Harness {
  const calls: string[] = [];
  const signOuts: SignOutReason[] = [];
  const store = new InMemoryTokenStore();

  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(request.url);
    return Promise.resolve(handler(request, calls.length));
  };

  const manager = new SessionManager({
    baseUrl: 'https://api.integr8.example',
    clientApp: 'mobile',
    clientVersion: '1.0.0',
    store,
    fetch: fetchImpl,
    now: () => NOW,
    onSignedOut: (reason) => signOuts.push(reason),
  });

  return { manager, store, calls, signOuts };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What the real API answers for a request with no bearer token. */
function unauthorised(): Response {
  return json(
    { error: { code: 'unauthorised', message: 'Authentication is required', requestId: 'r' } },
    401,
  );
}

/** A protected endpoint: 200 with a token, 401 without. */
function protectedRoute(request: Request): Response {
  return request.headers.has('authorization') ? json({ ok: true }) : unauthorised();
}

const refreshedPayload = {
  accessToken: 'access-2',
  accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
  refreshToken: 'refresh-2',
  refreshTokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
};

describe('signing in', () => {
  it('stores the tokens the server issued', async () => {
    const { manager, store } = harness(() =>
      json({
        tokens: refreshedPayload,
        tenantId: 'tenant-1',
        userId: 'user-1',
        memberships: [{ tenantId: 'tenant-1', role: 'owner', status: 'active' }],
      }),
    );

    const result = await manager.signInWithPassword({
      email: 'dana@northwind.example',
      password: 'a perfectly good passphrase',
    });

    expect(result.tenantId).toBe('tenant-1');
    expect(result.memberships).toHaveLength(1);
    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access-2' });
  });

  it('throws the API error rather than a generic one', async () => {
    const { manager } = harness(() =>
      json(
        {
          error: {
            code: 'auth.invalid_credentials',
            message: 'Invalid credentials',
            requestId: 'req-1',
          },
        },
        401,
      ),
    );

    await expect(
      manager.signInWithPassword({ email: 'dana@x.example', password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'auth.invalid_credentials', requestId: 'req-1' });
  });
});

describe('one refresh, however many requests need it', () => {
  /**
   * The behaviour this class mostly exists for. An app that opens six panels
   * at once, each with an expired token, must send one refresh — and the other
   * five must wait for it rather than each starting their own and invalidating
   * each other's rotated token.
   */
  it('sends one refresh for many concurrent requests', async () => {
    const { manager, store, calls } = harness((request) =>
      request.url.endsWith('/v1/auth/refresh') ? json(refreshedPayload) : protectedRoute(request),
    );

    await store.write(tokens({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) }));

    await Promise.all([
      manager.client.GET('/v1/me'),
      manager.client.GET('/v1/me'),
      manager.client.GET('/v1/me'),
      manager.client.GET('/v1/me'),
      manager.client.GET('/v1/me'),
      manager.client.GET('/v1/me'),
    ]);

    const refreshes = calls.filter((url) => url.endsWith('/v1/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('gives every waiting caller the new token', async () => {
    const { manager, store, calls } = harness((request) =>
      request.url.endsWith('/v1/auth/refresh') ? json(refreshedPayload) : protectedRoute(request),
    );

    await store.write(tokens({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) }));
    await Promise.all([manager.client.GET('/v1/me'), manager.client.GET('/v1/me')]);

    expect(calls.filter((url) => url.endsWith('/v1/me'))).toHaveLength(2);
    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access-2' });
  });

  it('refreshes again later, rather than latching for the life of the app', async () => {
    let issued = 0;
    const { manager, store, calls } = harness((request) => {
      if (request.url.endsWith('/v1/auth/refresh')) {
        issued += 1;
        return json({ ...refreshedPayload, accessToken: `access-${String(issued + 1)}` });
      }
      return protectedRoute(request);
    });

    await store.write(tokens({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) }));
    await manager.client.GET('/v1/me');

    // Expire the new one too, and go again.
    const current = await store.read();
    await store.write({ ...current!, accessTokenExpiresAt: new Date(NOW.getTime() - 1) });
    await manager.client.GET('/v1/me');

    expect(calls.filter((url) => url.endsWith('/v1/auth/refresh'))).toHaveLength(2);
  });

  it('refreshes early rather than waiting to be rejected', async () => {
    // Refreshing a minute early costs one round trip; not doing so costs a
    // failed request and a retry on a connection that may already be marginal.
    const { manager, store, calls } = harness((request) =>
      request.url.endsWith('/v1/auth/refresh') ? json(refreshedPayload) : protectedRoute(request),
    );

    await store.write(tokens({ accessTokenExpiresAt: new Date(NOW.getTime() + 30_000) }));
    await manager.client.GET('/v1/me');

    expect(calls.some((url) => url.endsWith('/v1/auth/refresh'))).toBe(true);
  });

  it('does not refresh a token that is still comfortably valid', async () => {
    const { manager, store, calls } = harness((request) => protectedRoute(request));

    await store.write(tokens());
    await manager.client.GET('/v1/me');

    expect(calls.some((url) => url.endsWith('/v1/auth/refresh'))).toBe(false);
  });
});

describe('when the refresh is dead', () => {
  it('signs out rather than retrying a credential that will never work', async () => {
    const { manager, store, signOuts } = harness((request) =>
      request.url.endsWith('/v1/auth/refresh')
        ? json({ error: { code: 'auth.session_revoked', message: 'Revoked', requestId: 'r' } }, 401)
        : protectedRoute(request),
    );

    await store.write(tokens({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) }));

    // The request goes out unauthenticated and is refused, which is what the
    // caller should see: the session is over, not merely stale.
    await expect(manager.client.GET('/v1/me')).rejects.toMatchObject({ status: 401 });

    await expect(store.read()).resolves.toBeUndefined();
    expect(signOuts).toEqual(['rejected']);
  });

  it('signs out without calling the server when the refresh token has expired', async () => {
    const { manager, store, calls, signOuts } = harness((request) => protectedRoute(request));

    await store.write(
      tokens({
        accessTokenExpiresAt: new Date(NOW.getTime() - 1),
        refreshTokenExpiresAt: new Date(NOW.getTime() - 1),
      }),
    );

    await expect(manager.client.GET('/v1/me')).rejects.toMatchObject({ status: 401 });

    expect(calls.some((url) => url.endsWith('/v1/auth/refresh'))).toBe(false);
    expect(signOuts).toEqual(['expired']);
  });
});

describe('the offline grant', () => {
  it('survives a refresh', async () => {
    /**
     * The refresh endpoint returns an access and a refresh token and says
     * nothing about the grant, which was issued separately and outlives both.
     * Dropping it here would silently disable offline working on the next
     * refresh — a bug only somebody who then lost signal would ever see.
     */
    const { manager, store } = harness((request) =>
      request.url.endsWith('/v1/auth/refresh') ? json(refreshedPayload) : protectedRoute(request),
    );

    await store.write(
      tokens({
        accessTokenExpiresAt: new Date(NOW.getTime() - 1),
        offlineGrant: 'grant-1',
        offlineGrantExpiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
      }),
    );

    await manager.client.GET('/v1/me');

    await expect(store.read()).resolves.toMatchObject({
      accessToken: 'access-2',
      offlineGrant: 'grant-1',
    });
  });

  it('counts as signed in when the refresh token has lapsed', async () => {
    // An engineer a week into a job with no signal: nothing else is usable and
    // the app still has to open.
    const { manager, store } = harness((request) => protectedRoute(request));

    await store.write(
      tokens({
        refreshTokenExpiresAt: new Date(NOW.getTime() - 1),
        offlineGrant: 'grant-1',
        offlineGrantExpiresAt: new Date(NOW.getTime() + 60_000),
      }),
    );

    await expect(manager.isSignedIn()).resolves.toBe(true);
    await expect(manager.canWorkOffline()).resolves.toBe(true);
  });

  it('is not signed in with no tokens at all', async () => {
    const { manager } = harness((request) => protectedRoute(request));

    await expect(manager.isSignedIn()).resolves.toBe(false);
    await expect(manager.canWorkOffline()).resolves.toBe(false);
  });
});

describe('signing out', () => {
  it('clears the device even when the server call fails', async () => {
    // Somebody who taps "sign out" on a train with no signal has ended their
    // session as far as they are concerned. Leaving a usable token on the
    // device would be the wrong way to disagree.
    const { manager, store, signOuts } = harness(() => {
      throw new Error('offline');
    });

    await store.write(tokens());
    await manager.signOut();

    await expect(store.read()).resolves.toBeUndefined();
    expect(signOuts).toEqual(['requested']);
  });
});
