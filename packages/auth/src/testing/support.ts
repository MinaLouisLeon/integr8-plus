import { toPlatformUserId, toTenantId, toUserId } from '@integr8/core';
import { type AuthConfig, authConfigSchema } from '../config.js';
import { generateSigningKeyPair, loadSigningKey, loadVerificationKeys } from '../keys.js';
import { TokenService } from '../tokens.js';

/**
 * Fixtures shared by the auth suites.
 *
 * Keys are generated per run rather than checked in. A test key in the
 * repository is a key somebody eventually reuses in a staging environment, and
 * generating an Ed25519 pair costs microseconds.
 */

/** 32 zero bytes, base64. Obviously a test key, and obviously not a secret. */
export const TEST_PLATFORM_SECRET_KEY = Buffer.alloc(32).toString('base64');

export interface TestAuth {
  config: AuthConfig;
  tokens: TokenService;
  /** Advances the clock the TokenService reads. */
  setNow: (date: Date) => void;
}

export async function buildTestAuth(
  overrides: Partial<Record<keyof AuthConfig, string>> = {},
  startAt: Date = new Date('2026-09-10T09:00:00.000Z'),
): Promise<TestAuth> {
  const pair = await generateSigningKeyPair(startAt);

  const config = authConfigSchema.parse({
    AUTH_ISSUER: 'https://api.test.integr8',
    AUTH_AUDIENCE: 'integr8-clients',
    AUTH_SIGNING_KEY_ID: pair.kid,
    AUTH_SIGNING_KEY: JSON.stringify(pair.privateJwk),
    AUTH_VERIFICATION_KEYS: JSON.stringify([pair.publicJwk]),
    // Fixed rather than generated: a suite that seals a secret in one process
    // and opens it in another needs the same key, and this one guards nothing
    // real. Never use it anywhere a real TOTP secret could be written.
    PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
    ...overrides,
  });

  let now = startAt;

  return {
    config,
    tokens: new TokenService({
      config,
      signingKey: await loadSigningKey(config),
      verificationKeys: await loadVerificationKeys(config),
      now: () => now,
    }),
    setNow: (date: Date) => {
      now = date;
    },
  };
}

// Branded, because the minting API takes branded ids and a test fixture that
// needs a cast is a fixture that stops catching the mistake the brands exist
// to catch.
export const TEST_USER = toUserId('018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071');
export const TEST_TENANT = toTenantId('00000000-0000-4000-8000-0000000000a1');
export const OTHER_TENANT = toTenantId('00000000-0000-4000-8000-0000000000b2');
export const TEST_SESSION = '00000000-0000-4000-8000-0000000005e5';
export const TEST_PLATFORM_USER = toPlatformUserId('00000000-0000-4000-8000-00000000f001');
export const TEST_GRANT = '00000000-0000-4000-8000-000000009111';
