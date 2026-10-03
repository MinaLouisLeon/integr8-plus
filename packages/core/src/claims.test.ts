import { describe, expect, it } from 'vitest';
import {
  accessTokenClaimsSchema,
  isImpersonating,
  offlineGrantClaimsSchema,
  toPrincipal,
} from './claims.js';

const USER = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const PLATFORM_USER = '00000000-0000-4000-8000-00000000f001';
const SESSION = '00000000-0000-4000-8000-0000000005e5';
const GRANT = '00000000-0000-4000-8000-000000009111';
const TOKEN_ID = '00000000-0000-4000-8000-00000000111d';

const access = {
  iss: 'https://api.integr8.example',
  aud: 'integr8-clients',
  sub: USER,
  jti: TOKEN_ID,
  iat: 1_757_500_000,
  exp: 1_757_500_900,
  typ: 'access',
  tid: TENANT,
  role: 'engineer',
  sid: SESSION,
};

describe('access token claims', () => {
  it('accepts a well-formed token', () => {
    expect(accessTokenClaimsSchema.parse(access).tid).toBe(TENANT);
  });

  it('rejects a tenant id that is not a uuid', () => {
    expect(accessTokenClaimsSchema.safeParse({ ...access, tid: 'northwind' }).success).toBe(false);
  });

  it('rejects a role the system does not define', () => {
    expect(accessTokenClaimsSchema.safeParse({ ...access, role: 'superadmin' }).success).toBe(
      false,
    );
  });

  it('rejects an offline grant presented as an access token', () => {
    expect(accessTokenClaimsSchema.safeParse({ ...access, typ: 'offline' }).success).toBe(false);
  });

  it('rejects a token with no session', () => {
    const { sid: _sid, ...withoutSession } = access;
    expect(accessTokenClaimsSchema.safeParse(withoutSession).success).toBe(false);
  });

  it('accepts an impersonation claim', () => {
    const parsed = accessTokenClaimsSchema.parse({
      ...access,
      imp: { pid: PLATFORM_USER, gid: GRANT },
    });

    expect(parsed.imp?.pid).toBe(PLATFORM_USER);
  });

  it('rejects an impersonation claim missing its grant', () => {
    expect(
      accessTokenClaimsSchema.safeParse({ ...access, imp: { pid: PLATFORM_USER } }).success,
    ).toBe(false);
  });
});

describe('offline grant claims', () => {
  const offline = { ...access, typ: 'offline', gid: GRANT };

  it('accepts a well-formed grant', () => {
    expect(offlineGrantClaimsSchema.parse(offline).gid).toBe(GRANT);
  });

  it('rejects an access token presented as an offline grant', () => {
    expect(offlineGrantClaimsSchema.safeParse(access).success).toBe(false);
  });

  it('requires the grant id, so a lost phone can be revoked on its own', () => {
    const { gid: _gid, ...withoutGrant } = offline;
    expect(offlineGrantClaimsSchema.safeParse(withoutGrant).success).toBe(false);
  });
});

describe('toPrincipal', () => {
  it('names the fields, so claims cannot be mistaken for verified identity', () => {
    const principal = toPrincipal(accessTokenClaimsSchema.parse(access));

    expect(principal).toEqual({
      userId: USER,
      tenantId: TENANT,
      role: 'engineer',
      sessionId: SESSION,
      tokenId: TOKEN_ID,
      expiresAt: new Date(access.exp * 1000),
    });
  });

  it('carries impersonation through, and omits the key entirely when absent', () => {
    const plain = toPrincipal(accessTokenClaimsSchema.parse(access));
    expect('impersonatedBy' in plain).toBe(false);
    expect(isImpersonating(plain)).toBe(false);

    const impersonated = toPrincipal(
      accessTokenClaimsSchema.parse({ ...access, imp: { pid: PLATFORM_USER, gid: GRANT } }),
    );
    expect(isImpersonating(impersonated)).toBe(true);
    expect(impersonated.impersonatedBy?.gid).toBe(GRANT);
  });
});
