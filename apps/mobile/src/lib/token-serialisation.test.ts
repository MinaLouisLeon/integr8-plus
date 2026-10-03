import type { StoredTokens } from '@integr8/core';
import { describe, expect, it } from 'vitest';
import { revive, serialise } from './token-serialisation';

/**
 * The round trip through SecureStore is JSON, and JSON has no date type.
 *
 * Getting this wrong produces a stored `Date` that comes back as a string, and
 * every expiry comparison after it silently becomes `string < Date` — which is
 * `false`, so the app decides the token is fine forever.
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

describe('storing a session on a phone', () => {
  it('round-trips through JSON with dates intact', () => {
    const original = tokens();
    const restored = revive(JSON.parse(JSON.stringify(serialise(original))) as never);

    expect(restored.accessToken).toBe(original.accessToken);
    expect(restored.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(restored.accessTokenExpiresAt.getTime()).toBe(original.accessTokenExpiresAt.getTime());
    expect(restored.refreshTokenExpiresAt.getTime()).toBe(original.refreshTokenExpiresAt.getTime());
  });

  it('keeps an offline grant, which outlives both tokens', () => {
    const grantExpiry = new Date(NOW.getTime() + 7 * 24 * 60 * 60_000);
    const original = tokens({ offlineGrant: 'grant-1', offlineGrantExpiresAt: grantExpiry });

    const restored = revive(JSON.parse(JSON.stringify(serialise(original))) as never);

    expect(restored.offlineGrant).toBe('grant-1');
    expect(restored.offlineGrantExpiresAt?.getTime()).toBe(grantExpiry.getTime());
  });

  it('omits the grant entirely when there is not one', () => {
    // Not `undefined` in the JSON — absent. A key present and undefined round
    // trips as `null`, which is a third state nothing handles.
    const serialised = serialise(tokens());

    expect('offlineGrant' in serialised).toBe(false);
    expect(revive(JSON.parse(JSON.stringify(serialised)) as never).offlineGrant).toBeUndefined();
  });

  it('produces something SecureStore can hold, which is a string', () => {
    expect(typeof JSON.stringify(serialise(tokens()))).toBe('string');
  });
});
