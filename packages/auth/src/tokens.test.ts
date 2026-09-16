import { SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authConfigSchema } from './config.js';
import { InvalidTokenError } from './errors.js';
import { generateSigningKeyPair, loadSigningKey, loadVerificationKeys } from './keys.js';
import {
  buildTestAuth,
  TEST_GRANT,
  TEST_PLATFORM_SECRET_KEY,
  TEST_PLATFORM_USER,
  TEST_SESSION,
  TEST_TENANT,
  TEST_USER,
} from './testing/support.js';
import { TokenService } from './tokens.js';

const access = {
  userId: TEST_USER,
  tenantId: TEST_TENANT,
  role: 'engineer',
} as const;

describe('access tokens', () => {
  it('round-trips through mint and verify', async () => {
    const auth = await buildTestAuth();
    const minted = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });
    const principal = await auth.tokens.verifyAccessToken(minted.token);

    expect(principal.userId).toBe(TEST_USER);
    expect(principal.tenantId).toBe(TEST_TENANT);
    expect(principal.role).toBe('engineer');
    expect(principal.sessionId).toBe(TEST_SESSION);
    expect(principal.tokenId).toBe(minted.tokenId);
  });

  it('gives every token a distinct id, so one can be denied without killing a session', async () => {
    const auth = await buildTestAuth();
    const first = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });
    const second = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });

    expect(first.tokenId).not.toBe(second.tokenId);
  });

  it('expires after the configured lifetime', async () => {
    const auth = await buildTestAuth({ AUTH_ACCESS_TOKEN_TTL_SECONDS: '900' });
    const minted = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });

    auth.setNow(new Date(minted.expiresAt.getTime() + 60_000));
    await expect(auth.tokens.verifyAccessToken(minted.token)).rejects.toThrow(InvalidTokenError);
  });

  it('carries an impersonation claim when there is one, and omits it otherwise', async () => {
    const auth = await buildTestAuth();

    const plain = await auth.tokens.verifyAccessToken(
      (await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION })).token,
    );
    expect(plain.impersonatedBy).toBeUndefined();

    const impersonated = await auth.tokens.verifyAccessToken(
      (
        await auth.tokens.mintAccessToken({
          ...access,
          sessionId: TEST_SESSION,
          impersonation: { pid: TEST_PLATFORM_USER, gid: TEST_GRANT },
        })
      ).token,
    );
    expect(impersonated.impersonatedBy).toEqual({ pid: TEST_PLATFORM_USER, gid: TEST_GRANT });
  });
});

describe('offline grants', () => {
  it('round-trips and lasts the configured window', async () => {
    const auth = await buildTestAuth();
    const minted = await auth.tokens.mintOfflineGrant({
      ...access,
      sessionId: TEST_SESSION,
      grantId: TEST_GRANT,
    });

    const claims = await auth.tokens.verifyOfflineGrant(minted.token);
    expect(claims.gid).toBe(TEST_GRANT);
    expect(claims.typ).toBe('offline');

    // Seven days by default: the working week an engineer plans in.
    const days = (minted.expiresAt.getTime() - Date.parse('2026-09-10T09:00:00.000Z')) / 86_400_000;
    expect(days).toBe(7);
  });

  it('honours a shorter window for a customer with a stricter policy', async () => {
    const auth = await buildTestAuth();
    const minted = await auth.tokens.mintOfflineGrant({
      ...access,
      sessionId: TEST_SESSION,
      grantId: TEST_GRANT,
      ttlSeconds: 86_400,
    });

    const days = (minted.expiresAt.getTime() - Date.parse('2026-09-10T09:00:00.000Z')) / 86_400_000;
    expect(days).toBe(1);
  });
});

describe('the two token types are not interchangeable', () => {
  /**
   * The check that makes the short access-token lifetime mean anything. An
   * offline grant lasts a week; if it were accepted where an access token is
   * expected, every mobile device would hold a week-long API credential.
   */
  it('refuses an offline grant where an access token is expected', async () => {
    const auth = await buildTestAuth();
    const offline = await auth.tokens.mintOfflineGrant({
      ...access,
      sessionId: TEST_SESSION,
      grantId: TEST_GRANT,
    });

    await expect(auth.tokens.verifyAccessToken(offline.token)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses an access token where an offline grant is expected', async () => {
    const auth = await buildTestAuth();
    const token = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });

    await expect(auth.tokens.verifyOfflineGrant(token.token)).rejects.toThrow(InvalidTokenError);
  });
});

describe('forgery', () => {
  it('refuses a token signed by a different key', async () => {
    const mine = await buildTestAuth();
    const theirs = await buildTestAuth();

    const foreign = await theirs.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });
    await expect(mine.tokens.verifyAccessToken(foreign.token)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses a token whose payload has been edited', async () => {
    const auth = await buildTestAuth();
    const minted = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });

    // Swap the tenant in the payload and re-encode. The signature no longer
    // covers it, which is the whole point.
    const [header, payload, signature] = minted.token.split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded.tid = '00000000-0000-4000-8000-0000000000b2';
    const tampered = [
      header,
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url'),
      signature,
    ].join('.');

    await expect(auth.tokens.verifyAccessToken(tampered)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses an HS256 token forged with the public key as the secret', async () => {
    // The classic algorithm-confusion attack: take the published verification
    // key, use its bytes as an HMAC secret, and hope the verifier trusts the
    // header's `alg`. The algorithm is pinned, so it does not.
    const auth = await buildTestAuth();
    const publicJwk = auth.tokens.publicJwks()[0];

    const forged = await new SignJWT({
      typ: 'access',
      tid: TEST_TENANT,
      role: 'owner',
      sid: TEST_SESSION,
    })
      .setProtectedHeader({ alg: 'HS256', kid: publicJwk?.kid ?? '' })
      .setIssuer(auth.config.AUTH_ISSUER)
      .setAudience(auth.config.AUTH_AUDIENCE)
      .setSubject(TEST_USER)
      .setJti(TEST_GRANT)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(Buffer.from(publicJwk?.x ?? '', 'base64url'));

    await expect(auth.tokens.verifyAccessToken(forged)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses a token with no key id', async () => {
    const auth = await buildTestAuth();
    const pair = await generateSigningKeyPair();
    const config = authConfigSchema.parse({
      AUTH_ISSUER: auth.config.AUTH_ISSUER,
      AUTH_AUDIENCE: auth.config.AUTH_AUDIENCE,
      AUTH_SIGNING_KEY_ID: pair.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(pair.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([pair.publicJwk]),
    });
    const signingKey = await loadSigningKey(config);

    const noKid = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(config.AUTH_ISSUER)
      .setAudience(config.AUTH_AUDIENCE)
      .setExpirationTime('1h')
      .sign(signingKey.key);

    await expect(auth.tokens.verifyAccessToken(noKid)).rejects.toThrow(/no key id/u);
  });

  it('refuses an empty or malformed token', async () => {
    const auth = await buildTestAuth();

    await expect(auth.tokens.verifyAccessToken('')).rejects.toThrow(InvalidTokenError);
    await expect(auth.tokens.verifyAccessToken('not-a-jwt')).rejects.toThrow(InvalidTokenError);
    await expect(
      auth.tokens.verifyAccessToken(randomBytes(48).toString('base64url')),
    ).rejects.toThrow(InvalidTokenError);
  });
});

describe('environment confusion', () => {
  it('refuses a token minted for another issuer', async () => {
    const staging = await buildTestAuth();
    const production = new TokenService({
      config: authConfigSchema.parse({
        AUTH_ISSUER: 'https://api.production.integr8',
        AUTH_AUDIENCE: staging.config.AUTH_AUDIENCE,
        AUTH_SIGNING_KEY_ID: staging.config.AUTH_SIGNING_KEY_ID,
        PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
        AUTH_SIGNING_KEY: staging.config.AUTH_SIGNING_KEY,
        AUTH_VERIFICATION_KEYS: staging.config.AUTH_VERIFICATION_KEYS,
      }),
      signingKey: await loadSigningKey(staging.config),
      verificationKeys: await loadVerificationKeys(staging.config),
    });

    const stagingToken = await staging.tokens.mintAccessToken({
      ...access,
      sessionId: TEST_SESSION,
    });

    // Same key, different issuer: still refused.
    await expect(production.verifyAccessToken(stagingToken.token)).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('refuses a token minted for another audience', async () => {
    const auth = await buildTestAuth();
    const otherAudience = new TokenService({
      config: authConfigSchema.parse({
        AUTH_ISSUER: auth.config.AUTH_ISSUER,
        AUTH_AUDIENCE: 'someone-elses-clients',
        AUTH_SIGNING_KEY_ID: auth.config.AUTH_SIGNING_KEY_ID,
        PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
        AUTH_SIGNING_KEY: auth.config.AUTH_SIGNING_KEY,
        AUTH_VERIFICATION_KEYS: auth.config.AUTH_VERIFICATION_KEYS,
      }),
      signingKey: await loadSigningKey(auth.config),
      verificationKeys: await loadVerificationKeys(auth.config),
    });

    const token = await auth.tokens.mintAccessToken({ ...access, sessionId: TEST_SESSION });
    await expect(otherAudience.verifyAccessToken(token.token)).rejects.toThrow(InvalidTokenError);
  });
});

describe('key rotation', () => {
  it('keeps verifying tokens signed by the previous key', async () => {
    const oldPair = await generateSigningKeyPair(new Date('2026-01-01T00:00:00.000Z'));
    const newPair = await generateSigningKeyPair(new Date('2026-09-10T00:00:00.000Z'));

    const before = authConfigSchema.parse({
      AUTH_ISSUER: 'https://api.test.integr8',
      AUTH_AUDIENCE: 'integr8-clients',
      AUTH_SIGNING_KEY_ID: oldPair.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(oldPair.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([oldPair.publicJwk]),
    });

    // Mid-rotation: signing with the new key, still accepting the old one.
    const during = authConfigSchema.parse({
      AUTH_ISSUER: before.AUTH_ISSUER,
      AUTH_AUDIENCE: before.AUTH_AUDIENCE,
      AUTH_SIGNING_KEY_ID: newPair.kid,
      PLATFORM_SECRET_KEY: TEST_PLATFORM_SECRET_KEY,
      AUTH_SIGNING_KEY: JSON.stringify(newPair.privateJwk),
      AUTH_VERIFICATION_KEYS: JSON.stringify([oldPair.publicJwk, newPair.publicJwk]),
    });

    const oldService = new TokenService({
      config: before,
      signingKey: await loadSigningKey(before),
      verificationKeys: await loadVerificationKeys(before),
    });
    const rotated = new TokenService({
      config: during,
      signingKey: await loadSigningKey(during),
      verificationKeys: await loadVerificationKeys(during),
    });

    const signedByOld = await oldService.mintAccessToken({ ...access, sessionId: TEST_SESSION });
    const signedByNew = await rotated.mintAccessToken({ ...access, sessionId: TEST_SESSION });

    // Both are accepted during the overlap — which is what makes a seven-day
    // offline grant survivable across a rotation.
    await expect(rotated.verifyAccessToken(signedByOld.token)).resolves.toMatchObject({
      userId: TEST_USER,
    });
    await expect(rotated.verifyAccessToken(signedByNew.token)).resolves.toMatchObject({
      userId: TEST_USER,
    });

    // And the old deployment, which has never heard of the new key, refuses it.
    await expect(oldService.verifyAccessToken(signedByNew.token)).rejects.toThrow(
      /does not accept/u,
    );
  });
});
