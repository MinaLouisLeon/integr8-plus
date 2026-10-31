import { decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  generateAuthDbPassword,
  generateAuthJwtSecret,
  mintServiceRoleKey,
} from './supabase-auth-keys.js';

describe('the self-hosted Auth secrets', () => {
  it('makes a JWT secret and a database password safe to put in a URL', () => {
    const secret = generateAuthJwtSecret();
    const password = generateAuthDbPassword();

    // 48 and 32 bytes, base64url without padding.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(generateAuthJwtSecret()).not.toBe(secret);
  });

  it('signs a service role key Auth will accept: HS256, no key id, role service_role', async () => {
    const secret = generateAuthJwtSecret();
    const now = new Date('2026-10-31T12:00:00Z');
    const key = await mintServiceRoleKey(secret, now);

    const header = decodeProtectedHeader(key);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(header.kid).toBeUndefined();

    // Auth uses the secret's characters as the key, so verifying with the
    // same encoding is what proves the container will accept it.
    const { payload } = await jwtVerify(key, new TextEncoder().encode(secret), {
      currentDate: now,
    });
    expect(payload.role).toBe('service_role');
    expect(payload.iss).toBe('integr8');
    expect(payload.iat).toBe(Math.floor(now.getTime() / 1000));
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(10 * 365 * 24 * 60 * 60);
  });

  it('is refused under a different secret', async () => {
    const key = await mintServiceRoleKey(generateAuthJwtSecret());
    await expect(
      jwtVerify(key, new TextEncoder().encode(generateAuthJwtSecret())),
    ).rejects.toThrow();
  });
});
