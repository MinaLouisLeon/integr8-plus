import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  canOpenOffline,
  InMemoryTokenStore,
  requiresSignIn,
  shouldRefresh,
  type StoredTokens,
} from './token-store.js';

const NOW = new Date('2026-09-10T09:00:00.000Z');

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000),
    ...overrides,
  };
}

describe('InMemoryTokenStore', () => {
  it('returns nothing before anything is written', async () => {
    await expect(new InMemoryTokenStore().read()).resolves.toBeUndefined();
  });

  it('round-trips a write', async () => {
    const store = new InMemoryTokenStore();
    await store.write(tokens());

    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access' });
  });

  it('copies on write, so a later mutation of the caller’s object does not change the store', async () => {
    const store = new InMemoryTokenStore();
    const original = tokens();
    await store.write(original);
    original.accessToken = 'tampered';

    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access' });
  });

  it('clears', async () => {
    const store = new InMemoryTokenStore();
    await store.write(tokens());
    await store.clear();

    await expect(store.read()).resolves.toBeUndefined();
  });
});

describe('shouldRefresh', () => {
  it('is false well before expiry', () => {
    expect(shouldRefresh(tokens(), NOW)).toBe(false);
  });

  it('is true inside the margin, before the token is actually rejected', () => {
    const nearlyExpired = tokens({
      accessTokenExpiresAt: new Date(NOW.getTime() + ACCESS_TOKEN_REFRESH_MARGIN_MS - 1),
    });

    expect(shouldRefresh(nearlyExpired, NOW)).toBe(true);
  });

  it('is true once expired', () => {
    const expired = tokens({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) });
    expect(shouldRefresh(expired, NOW)).toBe(true);
  });
});

describe('requiresSignIn', () => {
  it('is false while the refresh token lives', () => {
    expect(requiresSignIn(tokens(), NOW)).toBe(false);
  });

  it('is true once the refresh token has expired', () => {
    const stale = tokens({ refreshTokenExpiresAt: new Date(NOW.getTime() - 1) });
    expect(requiresSignIn(stale, NOW)).toBe(true);
  });
});

describe('canOpenOffline', () => {
  it('is false when no grant was issued', () => {
    expect(canOpenOffline(tokens(), NOW)).toBe(false);
  });

  it('is true while the grant is live', () => {
    const withGrant = tokens({
      offlineGrant: 'grant',
      offlineGrantExpiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
    });

    expect(canOpenOffline(withGrant, NOW)).toBe(true);
  });

  it('stays true after the refresh token has expired, which is the entire point', () => {
    // An engineer a week into a job with no signal: nothing else is usable and
    // the app still has to open.
    const inABasement = tokens({
      accessTokenExpiresAt: new Date(NOW.getTime() - 6 * 24 * 60 * 60_000),
      refreshTokenExpiresAt: new Date(NOW.getTime() - 1),
      offlineGrant: 'grant',
      offlineGrantExpiresAt: new Date(NOW.getTime() + 60_000),
    });

    expect(requiresSignIn(inABasement, NOW)).toBe(true);
    expect(canOpenOffline(inABasement, NOW)).toBe(true);
  });

  it('is false once the grant expires', () => {
    const lapsed = tokens({
      offlineGrant: 'grant',
      offlineGrantExpiresAt: new Date(NOW.getTime() - 1),
    });

    expect(canOpenOffline(lapsed, NOW)).toBe(false);
  });
});
