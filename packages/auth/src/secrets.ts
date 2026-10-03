import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { type TenantId, toTenantId } from '@integr8/core';

/**
 * Opaque secrets: refresh tokens and invitation tokens.
 *
 * These are not JWTs and deliberately carry no readable claims. A refresh token
 * that announced which company it unlocked would tell an attacker what they had
 * found before they spent it, and an invitation token that named the company
 * would leak the customer list to anyone who intercepted an email.
 *
 * Only the SHA-256 hash is ever stored. Not bcrypt or argon2: those exist to
 * make *guessing* expensive, and there is nothing here to guess — 256 bits from
 * a CSPRNG has no smaller search space to attack. What is wanted instead is a
 * hash that indexes, so a lookup is one b-tree probe rather than a scan of
 * every row with a work factor applied to each.
 */

/** Bytes of entropy per secret. 256 bits: not guessable, and not worth arguing about. */
const SECRET_BYTES = 32;

/**
 * Token prefixes.
 *
 * Distinct and greppable so that a secret scanner — gitleaks runs on this
 * repository in CI — can be taught to recognise one in a commit, a log file or
 * a support ticket. A leaked credential that looks like random text gets
 * pasted into a bug report; one that starts with `i8r1_` gets caught.
 */
export const REFRESH_TOKEN_PREFIX = 'i8r1';
export const INVITATION_TOKEN_PREFIX = 'i8i1';

const SEPARATOR = '.';

export interface TenantScopedSecret {
  /** The whole string, handed to the client exactly once and never stored. */
  token: string;
  /** What goes in the database. */
  hash: string;
  tenantId: TenantId;
}

/**
 * Mints a secret that names its own tenant.
 *
 * The tenant id is in the token because of a chicken-and-egg problem: the row
 * that would tell us which company a refresh token belongs to is itself behind
 * row-level security, which needs the company to be known before the lookup.
 * Carrying it in the token resolves that without weakening anything — the
 * tenant id is not a secret, and the 256 random bits beside it still are.
 */
export function mintTenantScopedSecret(
  prefix: string,
  tenantId: TenantId | string,
): TenantScopedSecret {
  const id = toTenantId(tenantId);
  const token = [prefix, id, randomBytes(SECRET_BYTES).toString('base64url')].join(SEPARATOR);

  return { token, hash: hashSecret(token), tenantId: id };
}

export interface ParsedSecret {
  tenantId: TenantId;
  hash: string;
}

/**
 * Reads the tenant out of a secret and hashes it, or returns undefined.
 *
 * Undefined rather than throwing: a malformed token is what an attacker sends,
 * and every rejected token should take the same path and produce the same
 * answer to the caller regardless of *why* it was rejected.
 */
export function parseTenantScopedSecret(prefix: string, token: string): ParsedSecret | undefined {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) {
    return undefined;
  }

  const [foundPrefix, tenantId, secret] = parts;
  if (foundPrefix !== prefix || tenantId === undefined || secret === undefined || secret === '') {
    return undefined;
  }

  try {
    return { tenantId: toTenantId(tenantId), hash: hashSecret(token) };
  } catch {
    // Not a uuid where a tenant id should be.
    return undefined;
  }
}

/** SHA-256, hex. Matches the `^[0-9a-f]{64}$` check constraint in migration 0003. */
export function hashSecret(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex hashes.
 *
 * Lookups here are by unique index, so this is rarely the deciding comparison —
 * but where a hash is compared in application code, doing it in variable time
 * leaks how much of it matched, one byte at a time.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function mintRefreshToken(tenantId: TenantId | string): TenantScopedSecret {
  return mintTenantScopedSecret(REFRESH_TOKEN_PREFIX, tenantId);
}

export function parseRefreshToken(token: string): ParsedSecret | undefined {
  return parseTenantScopedSecret(REFRESH_TOKEN_PREFIX, token);
}

export function mintInvitationToken(tenantId: TenantId | string): TenantScopedSecret {
  return mintTenantScopedSecret(INVITATION_TOKEN_PREFIX, tenantId);
}

export function parseInvitationToken(token: string): ParsedSecret | undefined {
  return parseTenantScopedSecret(INVITATION_TOKEN_PREFIX, token);
}

// ---------------------------------------------------------------------------
// Secrets the server must be able to read back (P15)
// ---------------------------------------------------------------------------

/**
 * A TOTP secret is not a password: verifying a code needs the secret itself, so
 * it cannot be hashed. It is therefore encrypted with a key held in the
 * environment and never in the database — AES-256-GCM, a fresh nonce per
 * secret, the ciphertext authenticated. A stolen database backup yields
 * nothing without the key; a stolen key yields nothing without the backup.
 *
 *   gcm1.<nonce base64url>.<ciphertext+tag base64url>
 */

export const SEALED_SECRET_PREFIX = 'gcm1';
const NONCE_BYTES = 12;

export class SealedSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedSecretError';
  }
}

/** The 32-byte key from configuration, as bytes. */
export function secretKeyFrom(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new SealedSecretError('PLATFORM_SECRET_KEY must be 32 bytes, base64 encoded');
  }
  return key;
}

export function sealSecret(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const sealed = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [SEALED_SECRET_PREFIX, nonce.toString('base64url'), sealed.toString('base64url')].join(
    '.',
  );
}

/** Throws {@link SealedSecretError} for anything that is not this key's ciphertext. */
export function openSecret(sealed: string, key: Buffer): string {
  const [prefix, nonce, payload] = sealed.split('.');
  if (prefix !== SEALED_SECRET_PREFIX || nonce === undefined || payload === undefined) {
    throw new SealedSecretError('Not a sealed secret');
  }
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length <= 16) {
    throw new SealedSecretError('Sealed secret is too short to hold a tag');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SealedSecretError('Sealed secret does not open with this key');
  }
}
