import { offlineGrantClaimsSchema } from '@integr8/core';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * Checking the offline grant on the phone, with no network (P03,
 * docs/auth/offline-access.md).
 *
 * The grant is an EdDSA JWT the API signs. The phone checks it against the
 * public keys built into the app (`EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`, the
 * deployment's `AUTH_VERIFICATION_KEYS`), so a grant edited in the keychain,
 * or minted by anybody but our API, does not open the app. Then it reads its
 * own `exp`, not a date stored beside it.
 *
 * Kept free of React Native so it runs under Node in the unit tests, against
 * grants signed the way the API signs them.
 */

/** One verification key: the `kid` it is named by, and its 32-byte Ed25519 public key. */
export interface GrantKey {
  kid: string;
  publicKey: Uint8Array;
}

export type GrantCheck =
  | { ok: true; expiresAt: Date; tenantId: string; userId: string }
  | {
      ok: false;
      reason:
        'malformed' | 'unknown_key' | 'bad_signature' | 'not_a_grant' | 'expired' | 'too_early';
    };

/** The build carried verification keys that cannot be used. */
export class InvalidVerificationKeysError extends Error {
  constructor(detail: string) {
    super(`EXPO_PUBLIC_AUTH_VERIFICATION_KEYS ${detail}`);
    this.name = 'InvalidVerificationKeysError';
  }
}

/**
 * How far ahead of the phone a grant may say it was issued: phones' clocks
 * drift, and refusing a grant minted a minute "in the future" would lock out
 * an engineer whose phone is a minute slow. A clock set back further than this,
 * to before the grant existed, is not drift.
 */
export const ISSUED_AT_TOLERANCE_MS = 5 * 60_000;

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url to bytes; undefined for anything that is not base64url. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = ((buffer << 6) | BASE64URL.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Bytes to text, as UTF-8; undefined for bytes that are not UTF-8. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return decodeURIComponent(
      Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    return undefined;
  }
}

function parseJson(bytes: Uint8Array | undefined): unknown {
  const text = bytes === undefined ? undefined : utf8(bytes);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** An Ed25519 signature check that answers false, rather than throwing, for a malformed one. */
function verifies(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Reads the keys the build carries: the same JSON array of public JWKs as the
 * API's `AUTH_VERIFICATION_KEYS`. A private key here would be a private key in
 * every copy of the app, so one is refused rather than used.
 */
export function parseVerificationKeys(raw: string): GrantKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidVerificationKeysError('is not JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidVerificationKeysError('must be a JSON array of public keys.');
  }
  const keys = parsed.map((entry: unknown, index): GrantKey => {
    const jwk = entry as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown; kid?: unknown };
    if (jwk.d !== undefined) {
      throw new InvalidVerificationKeysError(`[${String(index)}] holds a private key.`);
    }
    const publicKey = typeof jwk.x === 'string' ? fromBase64Url(jwk.x) : undefined;
    if (
      jwk.kty !== 'OKP' ||
      jwk.crv !== 'Ed25519' ||
      typeof jwk.kid !== 'string' ||
      jwk.kid === '' ||
      publicKey?.length !== 32
    ) {
      throw new InvalidVerificationKeysError(
        `[${String(index)}] is not an Ed25519 public key with a kid.`,
      );
    }
    return { kid: jwk.kid, publicKey };
  });
  if (keys.length === 0) {
    throw new InvalidVerificationKeysError('is empty.');
  }
  return keys;
}

/**
 * Whether `token` is an offline grant our API signed, and still running by
 * this phone's clock.
 *
 * The algorithm is pinned to EdDSA, never read from the header and believed:
 * that is how `alg: none` gets through. The `kid` only picks a key from the
 * set the build carries.
 */
export function checkOfflineGrant(token: string, keys: readonly GrantKey[], now: Date): GrantCheck {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts;
  const header = parseJson(fromBase64Url(encodedHeader)) as
    { alg?: unknown; kid?: unknown } | undefined;
  const signature = fromBase64Url(encodedSignature);
  if (header?.alg !== 'EdDSA' || typeof header.kid !== 'string' || signature?.length !== 64) {
    return { ok: false, reason: 'malformed' };
  }

  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (key === undefined) {
    return { ok: false, reason: 'unknown_key' };
  }
  const signed = Uint8Array.from(`${encodedHeader}.${encodedPayload}`, (char) =>
    char.charCodeAt(0),
  );
  if (!verifies(signature, signed, key.publicKey)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const claims = offlineGrantClaimsSchema.safeParse(parseJson(fromBase64Url(encodedPayload)));
  if (!claims.success) {
    return { ok: false, reason: 'not_a_grant' };
  }
  const { exp, iat, tid, sub } = claims.data;
  if (exp * 1000 <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (iat * 1000 > now.getTime() + ISSUED_AT_TOLERANCE_MS) {
    return { ok: false, reason: 'too_early' };
  }
  return { ok: true, expiresAt: new Date(exp * 1000), tenantId: tid, userId: sub };
}
