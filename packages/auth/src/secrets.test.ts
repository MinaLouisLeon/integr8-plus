import { describe, expect, it } from 'vitest';
import {
  hashesMatch,
  hashSecret,
  INVITATION_TOKEN_PREFIX,
  mintInvitationToken,
  mintRefreshToken,
  parseInvitationToken,
  parseRefreshToken,
  REFRESH_TOKEN_PREFIX,
} from './secrets.js';

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000b2';

describe('minting', () => {
  it('produces a token that names its prefix and its tenant', () => {
    const secret = mintRefreshToken(TENANT);
    const [prefix, tenantId, random] = secret.token.split('.');

    expect(prefix).toBe(REFRESH_TOKEN_PREFIX);
    expect(tenantId).toBe(TENANT);
    expect(random).toBeDefined();
    expect(secret.tenantId).toBe(TENANT);
  });

  it('carries 256 bits of randomness', () => {
    // 32 bytes, base64url — 43 characters with no padding.
    const random = mintRefreshToken(TENANT).token.split('.')[2] ?? '';
    expect(random.length).toBe(43);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintRefreshToken(TENANT).token));
    expect(tokens.size).toBe(500);
  });

  it('stores a sha-256 hash matching the database check constraint', () => {
    expect(mintRefreshToken(TENANT).hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('never returns the hash as the token', () => {
    const secret = mintRefreshToken(TENANT);
    expect(secret.token).not.toContain(secret.hash);
  });

  it('rejects a tenant id that is not a uuid', () => {
    expect(() => mintRefreshToken('northwind')).toThrow();
  });
});

describe('parsing', () => {
  it('recovers the tenant and the hash', () => {
    const secret = mintRefreshToken(TENANT);
    const parsed = parseRefreshToken(secret.token);

    expect(parsed?.tenantId).toBe(TENANT);
    expect(parsed?.hash).toBe(secret.hash);
  });

  it('refuses a token of the wrong kind', () => {
    // An invitation token must not be spendable as a refresh token: it is
    // emailed, so it travels through more hands.
    const invitation = mintInvitationToken(TENANT);

    expect(parseRefreshToken(invitation.token)).toBeUndefined();
    expect(parseInvitationToken(invitation.token)?.tenantId).toBe(TENANT);
  });

  it('returns undefined rather than throwing for anything malformed', () => {
    // Every rejection takes the same path, so a caller cannot learn *why* a
    // token was refused from how it failed.
    for (const bad of [
      '',
      'nonsense',
      `${REFRESH_TOKEN_PREFIX}.${TENANT}`,
      `${REFRESH_TOKEN_PREFIX}.${TENANT}.`,
      `${REFRESH_TOKEN_PREFIX}.not-a-uuid.abcdef`,
      `${REFRESH_TOKEN_PREFIX}.${TENANT}.abc.def`,
      `${INVITATION_TOKEN_PREFIX}.${TENANT}.abcdef`,
    ]) {
      expect(parseRefreshToken(bad), bad).toBeUndefined();
    }
  });

  it('hashes the whole token, so the same random half under another tenant differs', () => {
    const random = mintRefreshToken(TENANT).token.split('.')[2] ?? '';
    const here = parseRefreshToken(`${REFRESH_TOKEN_PREFIX}.${TENANT}.${random}`);
    const there = parseRefreshToken(`${REFRESH_TOKEN_PREFIX}.${OTHER_TENANT}.${random}`);

    expect(here?.hash).not.toBe(there?.hash);
  });
});

describe('hashing', () => {
  it('is stable', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
  });

  it('is the well-known sha-256 of a known input', () => {
    expect(hashSecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares equal hashes and rejects unequal ones', () => {
    expect(hashesMatch(hashSecret('abc'), hashSecret('abc'))).toBe(true);
    expect(hashesMatch(hashSecret('abc'), hashSecret('abd'))).toBe(false);
    expect(hashesMatch('short', hashSecret('abc'))).toBe(false);
  });
});
