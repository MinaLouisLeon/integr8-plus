import type { StoredTokens } from '@integr8/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenStore, isTauri, MemoryTokenStore } from './platform';

/**
 * The desktop app ships one bundle that runs in two places, so the thing worth
 * testing is that it can tell which one it is in and picks the right token
 * store — because picking wrong means either a crash in a browser tab or a
 * refresh token that does not survive a restart.
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

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('knowing where it is running', () => {
  it('is not Tauri when there is no window at all', () => {
    // Server-side rendering, or a test. Neither should throw.
    expect(isTauri()).toBe(false);
  });

  it('is not Tauri in a plain browser tab', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(isTauri()).toBe(false);
  });

  it('is Tauri when the shell has injected its internals', () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isTauri()).toBe(true);
  });

  it('picks the keychain in Tauri and memory in a browser', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(createTokenStore()).toBeInstanceOf(MemoryTokenStore);

    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(createTokenStore()).not.toBeInstanceOf(MemoryTokenStore);
  });
});

describe('the browser fallback store', () => {
  it('round-trips tokens', async () => {
    const store = new MemoryTokenStore();
    await store.write(tokens());

    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access-1' });
  });

  it('starts empty', async () => {
    await expect(new MemoryTokenStore().read()).resolves.toBeUndefined();
  });

  it('copies on write, so a later mutation does not reach into the store', async () => {
    const store = new MemoryTokenStore();
    const original = tokens();
    await store.write(original);
    original.accessToken = 'tampered';

    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access-1' });
  });

  it('clears', async () => {
    const store = new MemoryTokenStore();
    await store.write(tokens());
    await store.clear();

    await expect(store.read()).resolves.toBeUndefined();
  });

  it('keeps an offline grant alongside the session', async () => {
    const store = new MemoryTokenStore();
    await store.write(
      tokens({ offlineGrant: 'grant-1', offlineGrantExpiresAt: new Date(NOW.getTime() + 1000) }),
    );

    await expect(store.read()).resolves.toMatchObject({ offlineGrant: 'grant-1' });
  });
});
