// Node's own crypto signs the grants here; the app's tsconfig has no Node types.
/// <reference types="node" />
import { generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkOfflineGrant,
  fromBase64Url,
  type GrantKey,
  InvalidVerificationKeysError,
  parseVerificationKeys,
} from './offline-grant';

/**
 * Grants signed here the way the API signs them (EdDSA over Ed25519, a `kid`
 * in the header, the claims `@integr8/core` defines), with Node's own crypto:
 * nothing this file shares with the code under test.
 */

const NOW = new Date('2026-10-31T09:00:00.000Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const DAY = 86_400_000;

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' } };
}

const ours = keyPair('integr8-2026-10-01-abcd');
const stranger = keyPair('integr8-2026-10-01-abcd');
const KEYS: GrantKey[] = parseVerificationKeys(JSON.stringify([ours.jwk]));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://api.integr8.example',
    aud: 'integr8',
    sub: randomUUID(),
    jti: randomUUID(),
    iat: seconds(NOW),
    exp: seconds(new Date(NOW.getTime() + 7 * DAY)),
    typ: 'offline',
    tid: randomUUID(),
    role: 'engineer',
    sid: randomUUID(),
    gid: randomUUID(),
    ...overrides,
  };
}

function grant(
  payload: Record<string, unknown>,
  options: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = encode({ alg: options.alg ?? 'EdDSA', kid: options.kid ?? ours.kid, typ: 'JWT' });
  const body = encode(payload);
  const signature = sign(null, Buffer.from(`${header}.${body}`), options.key ?? ours.privateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

describe('the offline grant on the phone', () => {
  it('opens on a grant our API signed, until the end the grant itself states', () => {
    const issued = claims();
    const check = checkOfflineGrant(grant(issued), KEYS, NOW);
    expect(check).toEqual({
      ok: true,
      expiresAt: new Date(issued.exp * 1000),
      tenantId: issued.tid,
      userId: issued.sub,
    });
    expect(checkOfflineGrant(grant(issued), KEYS, new Date(issued.exp * 1000))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a grant edited on the phone: a later end, a different company', () => {
    const genuine = grant(claims()).split('.');
    const longer = encode(claims({ exp: seconds(new Date(NOW.getTime() + 365 * DAY)) }));
    expect(checkOfflineGrant(`${genuine[0]}.${longer}.${genuine[2]}`, KEYS, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a grant signed by any other key, even one claiming our key’s id', () => {
    expect(checkOfflineGrant(grant(claims(), { key: stranger.privateKey }), KEYS, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(checkOfflineGrant(grant(claims(), { kid: 'someone-else' }), KEYS, NOW)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('refuses an unsigned token and one that names another algorithm', () => {
    const unsigned = `${encode({ alg: 'none', kid: ours.kid })}.${encode(claims())}.`;
    expect(checkOfflineGrant(unsigned, KEYS, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkOfflineGrant(grant(claims(), { alg: 'HS256' }), KEYS, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(checkOfflineGrant('not a token', KEYS, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses our own access token: only a grant opens the phone', () => {
    const access = claims({ typ: 'access', exp: seconds(new Date(NOW.getTime() + 60_000)) });
    expect(checkOfflineGrant(grant(access), KEYS, NOW)).toEqual({
      ok: false,
      reason: 'not_a_grant',
    });
  });

  it('refuses a grant from before the phone’s clock was set back, and allows a few minutes’ drift', () => {
    const issued = claims({ iat: seconds(new Date(NOW.getTime() + 2 * DAY)) });
    expect(checkOfflineGrant(grant(issued), KEYS, NOW)).toEqual({ ok: false, reason: 'too_early' });
    const drift = claims({ iat: seconds(new Date(NOW.getTime() + 60_000)) });
    expect(checkOfflineGrant(grant(drift), KEYS, NOW).ok).toBe(true);
  });
});

describe('the keys a build carries', () => {
  it('reads the API’s AUTH_VERIFICATION_KEYS as it is, with a second key during a rotation', () => {
    const next = keyPair('integr8-2026-11-01-wxyz');
    const keys = parseVerificationKeys(JSON.stringify([ours.jwk, next.jwk]));
    expect(keys.map((key) => key.kid)).toEqual([ours.kid, next.kid]);
    expect(
      checkOfflineGrant(grant(claims(), { key: next.privateKey, kid: next.kid }), keys, NOW).ok,
    ).toBe(true);
  });

  it('refuses a private key, an empty list, and anything that is not a list of Ed25519 keys', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const secret = { ...privateKey.export({ format: 'jwk' }), kid: 'leaked' };
    for (const raw of [
      JSON.stringify([secret]),
      '[]',
      '{}',
      'not json',
      JSON.stringify([{ kty: 'RSA', kid: 'x', n: 'abc', e: 'AQAB' }]),
    ]) {
      expect(() => parseVerificationKeys(raw)).toThrow(InvalidVerificationKeysError);
    }
  });

  it('decodes base64url exactly as Node does', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 64]) {
      const bytes = new Uint8Array(Array.from({ length }, (_, index) => (index * 37 + 11) % 256));
      expect(fromBase64Url(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
    }
    expect(fromBase64Url('a+b/')).toBeUndefined();
  });
});
