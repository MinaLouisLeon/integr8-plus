import type { StoredTokens } from '@integr8/core';

/**
 * Turning a session into a string and back.
 *
 * Separate from `platform.ts` because that file imports `expo-secure-store`,
 * which pulls in React Native — and React Native's source is Flow-typed, which
 * nothing but Metro can parse. Keeping the logic here means it can be tested
 * without a simulator, and what it does is worth testing:
 *
 * JSON has no date type. Getting this wrong stores a `Date` that comes back as
 * a string, and every expiry comparison afterwards silently becomes
 * `string < Date` — which is `false`, so the app decides the token is fine
 * forever.
 */

export interface SerialisedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  offlineGrant?: string | undefined;
  offlineGrantExpiresAt?: string | undefined;
}

export function serialise(tokens: StoredTokens): SerialisedTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    // Omitted entirely rather than set to undefined: a key present and
    // undefined round-trips as `null`, which is a third state nothing handles.
    ...(tokens.offlineGrant === undefined
      ? {}
      : {
          offlineGrant: tokens.offlineGrant,
          offlineGrantExpiresAt: tokens.offlineGrantExpiresAt?.toISOString(),
        }),
  };
}

export function revive(stored: SerialisedTokens): StoredTokens {
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
