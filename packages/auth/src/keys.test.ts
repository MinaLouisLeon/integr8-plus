import { describe, expect, it } from 'vitest';
import { authConfigSchema } from './config.js';
import {
  generateSigningKeyPair,
  KeyConfigurationError,
  loadSigningKey,
  loadVerificationKeys,
} from './keys.js';
import { TEST_PLATFORM_SECRET_KEY } from './testing/support.js';

const BASE = {
  AUTH_ISSUER: 'https://api.test.integr8',
  AUTH_AUDIENCE: 'integr8-clients',
};

async function config(overrides: Record<string, string>) {
  const pair = await generateSigningKeyPair();
  return {
    pair,
    parsed: authConfigSchema.parse({
      ...BASE,
      AUTH_SIGNING_KEY_ID: pair.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(pair.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([pair.publicJwk]),
      ...overrides,
    }),
  };
}

describe('generateSigningKeyPair', () => {
  it('produces an Ed25519 pair with a dated key id', async () => {
    const pair = await generateSigningKeyPair(new Date('2026-09-10T00:00:00.000Z'));

    expect(pair.kid).toMatch(/^integr8-2026-09-10-[a-z0-9]+$/u);
    expect(pair.privateJwk.crv).toBe('Ed25519');
    expect(pair.publicJwk.crv).toBe('Ed25519');
  });

  it('puts private material in the private key and none in the public one', async () => {
    const pair = await generateSigningKeyPair();

    expect(pair.privateJwk.d).toBeDefined();
    expect(pair.publicJwk.d).toBeUndefined();
  });

  it('never repeats a key id', async () => {
    const kids = await Promise.all(
      Array.from({ length: 8 }, async () => (await generateSigningKeyPair()).kid),
    );

    expect(new Set(kids).size).toBe(kids.length);
  });
});

describe('loadSigningKey', () => {
  it('loads a well-formed private key', async () => {
    const { pair, parsed } = await config({});
    await expect(loadSigningKey(parsed)).resolves.toMatchObject({ kid: pair.kid });
  });

  it('refuses a public key where a private one is needed', async () => {
    const pair = await generateSigningKeyPair();
    const parsed = authConfigSchema.parse({
      ...BASE,
      AUTH_SIGNING_KEY_ID: pair.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(pair.publicJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([pair.publicJwk]),
    });

    await expect(loadSigningKey(parsed)).rejects.toThrow(/public key/u);
  });

  it('refuses a key whose id disagrees with AUTH_SIGNING_KEY_ID', async () => {
    // Tokens would be signed under one id and announced under another, so
    // nothing could verify them — a failure worth catching at startup rather
    // than on the first request.
    const { parsed } = await config({ AUTH_SIGNING_KEY_ID: 'some-other-key' });

    await expect(loadSigningKey(parsed)).rejects.toThrow(/AUTH_SIGNING_KEY_ID/u);
  });

  it('refuses something that is not JSON', async () => {
    const { parsed } = await config({ AUTH_SIGNING_KEY: 'not-json' });
    await expect(loadSigningKey(parsed)).rejects.toThrow(KeyConfigurationError);
  });

  it('refuses a key on the wrong curve', async () => {
    const { pair, parsed } = await config({});
    const wrongCurve = JSON.stringify({ ...pair.privateJwk, crv: 'P-256' });

    await expect(loadSigningKey({ ...parsed, AUTH_SIGNING_KEY: wrongCurve })).rejects.toThrow(
      KeyConfigurationError,
    );
  });
});

describe('loadVerificationKeys', () => {
  it('loads a single-key set', async () => {
    const { pair, parsed } = await config({});
    const keys = await loadVerificationKeys(parsed);

    expect(keys.kids()).toEqual([pair.kid]);
    await expect(keys.find(pair.kid)).resolves.toBeDefined();
    await expect(keys.find('unknown')).resolves.toBeUndefined();
  });

  it('publishes keys with alg and use set, ready for a JWKS endpoint', async () => {
    const { parsed } = await config({});
    const [published] = (await loadVerificationKeys(parsed)).publicJwks();

    expect(published).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(published?.d).toBeUndefined();
  });

  it('refuses private key material in the published set', async () => {
    // These keys are served at a JWKS endpoint and embedded in a mobile binary
    // anyone can extract. A `d` here is a private key on the App Store.
    const { pair, parsed } = await config({});
    const withPrivate = { ...parsed, AUTH_VERIFICATION_KEYS: JSON.stringify([pair.privateJwk]) };

    await expect(loadVerificationKeys(withPrivate)).rejects.toThrow(/private key material/u);
  });

  it('refuses an empty set', async () => {
    const { parsed } = await config({ AUTH_VERIFICATION_KEYS: '[]' });
    await expect(loadVerificationKeys(parsed)).rejects.toThrow(/empty/u);
  });

  it('refuses two keys sharing an id', async () => {
    const first = await generateSigningKeyPair();
    const second = await generateSigningKeyPair();
    const parsed = authConfigSchema.parse({
      ...BASE,
      AUTH_SIGNING_KEY_ID: first.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(first.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([
        first.publicJwk,
        { ...second.publicJwk, kid: first.kid },
      ]),
    });

    await expect(loadVerificationKeys(parsed)).rejects.toThrow(/two keys with kid/u);
  });

  it('refuses a set that does not include the signing key', async () => {
    // The deployment would issue tokens it could not verify — every request
    // after the next restart would fail, and the cause would be non-obvious.
    const signing = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const parsed = authConfigSchema.parse({
      ...BASE,
      AUTH_SIGNING_KEY_ID: signing.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(signing.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([other.publicJwk]),
    });

    await expect(loadVerificationKeys(parsed)).rejects.toThrow(/does not include the signing key/u);
  });

  it('refuses something that is not an array', async () => {
    const { pair, parsed } = await config({});
    const notAnArray = { ...parsed, AUTH_VERIFICATION_KEYS: JSON.stringify(pair.publicJwk) };

    await expect(loadVerificationKeys(notAnArray)).rejects.toThrow(/JSON array/u);
  });

  it('accepts the two-key set a rotation needs', async () => {
    const outgoing = await generateSigningKeyPair();
    const incoming = await generateSigningKeyPair();
    const parsed = authConfigSchema.parse({
      ...BASE,
      AUTH_SIGNING_KEY_ID: incoming.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(incoming.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([outgoing.publicJwk, incoming.publicJwk]),
    });

    expect((await loadVerificationKeys(parsed)).kids().sort()).toEqual(
      [outgoing.kid, incoming.kid].sort(),
    );
  });
});
