import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Passwords for platform users (P15).
 *
 * Tenant users authenticate through Supabase, which holds their passwords. A
 * super admin cannot: the locked decision is that platform identity stays
 * outside tenant auth, and a second Supabase project for two accounts would be
 * a second thing to secure, keep and rotate.
 *
 * So the hash lives beside the account, made with scrypt from Node's own
 * crypto. Memory-hard, in the standard library, with no dependency to audit —
 * and the parameters are stored in the string, so raising them later verifies
 * old hashes with their own cost and re-hashes on the next sign-in.
 *
 *   scrypt$16384$8$1$<salt base64url>$<hash base64url>
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP's floor for scrypt, and about 90 ms on a small server. */
export const SCRYPT_PARAMETERS = Object.freeze({ N: 16_384, r: 8, p: 1 });
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = SCRYPT_PARAMETERS;
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    String(N),
    String(r),
    String(p),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Whether a password matches a stored hash.
 *
 * Never throws for a malformed hash: an account whose hash is corrupt must fail
 * to sign in, not fail the request with a stack trace that says why.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) {
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const parameters = { N: Number(n), r: Number(r), p: Number(p) };
  if (
    !Number.isInteger(parameters.N) ||
    !Number.isInteger(parameters.r) ||
    !Number.isInteger(parameters.p)
  ) {
    return false;
  }

  const expectedBytes = Buffer.from(expected, 'base64url');
  try {
    const derived = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(salt, 'base64url'),
      expectedBytes.length,
      {
        ...parameters,
        maxmem: MAX_MEMORY,
      },
    );
    return derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than today's. */
export function needsRehash(stored: string | null): boolean {
  if (stored === null) {
    return true;
  }
  const [scheme, n, r, p] = stored.split('$');
  return (
    scheme !== 'scrypt' ||
    Number(n) < SCRYPT_PARAMETERS.N ||
    Number(r) < SCRYPT_PARAMETERS.r ||
    Number(p) < SCRYPT_PARAMETERS.p
  );
}
