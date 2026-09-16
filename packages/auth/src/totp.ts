import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The second factor for a platform user (P15): TOTP, RFC 6238.
 *
 * Thirty-second steps, six digits, SHA-1 — not because SHA-1 is a good hash,
 * but because every authenticator app implements exactly this and a code that
 * only works in one app is a code that locks somebody out. The security here is
 * the shared secret, which is 160 random bits and never leaves the server
 * except as a QR code the person scans once.
 *
 * Implemented here rather than taken from a package: it is thirty lines, and a
 * dependency that generates one-time codes is a dependency with an unusually
 * good position from which to leak them.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** How many steps either side are accepted: one, for a clock that is a little out. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** The `otpauth://` URI an authenticator app reads from a QR code. */
export function totpUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const parameters = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/** The code for one moment, for tests and for the enrolment check. */
export function totpCode(secret: string, at: Date = new Date(), step = 0): string {
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS) + step;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Whether a code is right now, allowing one step either side.
 *
 * Compared in constant time, and a malformed secret or code is false rather
 * than an exception: a wrong code is a wrong code however it is wrong.
 */
export function verifyTotp(secret: string | null, code: string, at: Date = new Date()): boolean {
  if (secret === null) {
    return false;
  }
  const cleaned = code.replaceAll(/\s/gu, '');
  if (!/^\d{6}$/u.test(cleaned)) {
    return false;
  }
  try {
    for (let step = -TOTP_WINDOW; step <= TOTP_WINDOW; step += 1) {
      const expected = Buffer.from(totpCode(secret, at, step));
      if (timingSafeEqual(expected, Buffer.from(cleaned))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replaceAll(/[^A-Z2-7]/gu, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index === -1) {
      throw new Error('Not a base32 secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length === 0) {
    throw new Error('Not a base32 secret');
  }
  return Buffer.from(bytes);
}
