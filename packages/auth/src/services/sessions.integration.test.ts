import { toTenantId } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountLockedError,
  ImpersonationDeniedError,
  InvalidCredentialsError,
  InvalidTokenError,
  NotAMemberError,
  RefreshTokenReuseError,
  SessionRevokedError,
} from '../errors.js';
import {
  buildServices,
  createMember,
  createPlatformUser,
  createTenant,
  type MemberFixture,
  releaseServices,
  type TenantFixture,
  type TestServices,
  uniqueEmail,
} from '../testing/harness.js';

/**
 * Sign-in, rotation, revocation and the offline grant, against a real database.
 *
 * The unit suites prove the cryptography. This proves the parts that only exist
 * once there are rows: that a token cannot be pointed at another company, that
 * a stolen refresh token is detected, that revoking a session actually stops
 * the device.
 */

let services: TestServices;
let northwind: TenantFixture;
let southgate: TenantFixture;
let dana: MemberFixture;
let marek: MemberFixture;

beforeAll(async () => {
  services = await buildServices();
  northwind = await createTenant('northwind');
  southgate = await createTenant('southgate');

  dana = await createMember(services.identity, northwind.id, 'owner', 'dana');
  marek = await createMember(services.identity, southgate.id, 'owner', 'marek');
});

afterAll(async () => {
  await releaseServices();
});

describe('signing in', () => {
  it('issues a token that names the company and the role', async () => {
    const result = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });

    const principal = await services.tokens.verifyAccessToken(result.tokens.accessToken);

    expect(principal.tenantId).toBe(northwind.id);
    expect(principal.userId).toBe(dana.userId);
    expect(principal.role).toBe('owner');
    expect(principal.sessionId).toBe(result.tokens.session.id);
  });

  it('writes an audit entry naming the session', async () => {
    const result = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'desktop',
    });

    const entries = await withTenant(northwind.id, (tx) =>
      tx.auditLog.list({ resourceType: 'session', resourceId: result.tokens.session.id }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('auth.signed_in');
    expect(entries[0]?.tenantId).toBe(northwind.id);
  });

  it('refuses a wrong password', async () => {
    await expect(
      services.signIn.signInWithPassword({
        email: dana.email,
        password: 'not the password',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('refuses an identity that belongs to no company, indistinguishably', async () => {
    // An account with no membership must look exactly like a wrong password,
    // or the sign-in form becomes a way to test whether an address is a
    // customer.
    const orphan = uniqueEmail('orphan');
    await services.identity.createIdentity(orphan, 'a perfectly good passphrase');

    await expect(
      services.signIn.signInWithPassword({
        email: orphan,
        password: 'a perfectly good passphrase',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('refuses to sign in to a company the person does not belong to', async () => {
    await expect(
      services.signIn.signInWithPassword({
        email: dana.email,
        password: dana.password,
        clientApp: 'web',
        tenantId: southgate.id,
      }),
    ).rejects.toThrow(NotAMemberError);
  });
});

describe('lockout', () => {
  it('locks an address after repeated failures and lets it back in after the window', async () => {
    const victim = await createMember(services.identity, northwind.id, 'engineer', 'victim');
    const start = new Date();
    services.setNow(start);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        services.signIn.signInWithPassword({
          email: victim.email,
          password: 'wrong',
          clientApp: 'web',
        }),
      ).rejects.toThrow(InvalidCredentialsError);
    }

    // The right password now fails too — that is what a lock is.
    await expect(
      services.signIn.signInWithPassword({
        email: victim.email,
        password: victim.password,
        clientApp: 'web',
      }),
    ).rejects.toThrow(AccountLockedError);

    services.setNow(new Date(start.getTime() + 16 * 60_000));

    await expect(
      services.signIn.signInWithPassword({
        email: victim.email,
        password: victim.password,
        clientApp: 'web',
      }),
    ).resolves.toBeDefined();

    services.setNow(new Date());
  });

  it('does not lock somebody out for occasional typos spread over time', async () => {
    const forgetful = await createMember(services.identity, northwind.id, 'viewer', 'forgetful');
    const start = new Date();

    // Nine failures, each more than an hour after the last: the window closes
    // between them so the count restarts every time.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      services.setNow(new Date(start.getTime() + attempt * 2 * 60 * 60_000));
      await expect(
        services.signIn.signInWithPassword({
          email: forgetful.email,
          password: 'wrong',
          clientApp: 'web',
        }),
      ).rejects.toThrow(InvalidCredentialsError);
    }

    services.setNow(new Date(start.getTime() + 9 * 2 * 60 * 60_000));
    await expect(
      services.signIn.signInWithPassword({
        email: forgetful.email,
        password: forgetful.password,
        clientApp: 'web',
      }),
    ).resolves.toBeDefined();

    services.setNow(new Date());
  });
});

describe('refresh rotation', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const first = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'mobile',
    });

    const second = await services.sessions.refresh(first.tokens.refreshToken);

    expect(second.refreshToken).not.toBe(first.tokens.refreshToken);
    expect(second.session.id).toBe(first.tokens.session.id);

    const principal = await services.tokens.verifyAccessToken(second.accessToken);
    expect(principal.tenantId).toBe(northwind.id);
  });

  it('refuses the old token once it has been rotated, and kills the session', async () => {
    // The theft signal: the legitimate holder has moved on, so anyone
    // presenting the spent token is not the legitimate holder.
    const first = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'mobile',
    });

    const second = await services.sessions.refresh(first.tokens.refreshToken);

    await expect(services.sessions.refresh(first.tokens.refreshToken)).rejects.toThrow(
      RefreshTokenReuseError,
    );

    // And the replacement is dead too — the whole session went.
    await expect(services.sessions.refresh(second.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('records the reuse in the audit log', async () => {
    const first = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'mobile',
    });
    await services.sessions.refresh(first.tokens.refreshToken);
    await expect(services.sessions.refresh(first.tokens.refreshToken)).rejects.toThrow(
      RefreshTokenReuseError,
    );

    const entries = await withTenant(northwind.id, (tx) =>
      tx.auditLog.list({ resourceType: 'session', resourceId: first.tokens.session.id }),
    );

    expect(entries.some((entry) => entry.action === 'session.refresh_token_reused')).toBe(true);
  });

  it('refuses a malformed or invented refresh token', async () => {
    for (const bad of ['', 'nonsense', `i8r1.${northwind.id}.invented`]) {
      await expect(services.sessions.refresh(bad)).rejects.toThrow(InvalidTokenError);
    }
  });

  it('picks up a role change within one access-token lifetime', async () => {
    const promoted = await createMember(services.identity, northwind.id, 'viewer', 'promoted');
    const signedIn = await services.signIn.signInWithPassword({
      email: promoted.email,
      password: promoted.password,
      clientApp: 'web',
    });

    expect((await services.tokens.verifyAccessToken(signedIn.tokens.accessToken)).role).toBe(
      'viewer',
    );

    await withTenant(northwind.id, (tx) =>
      tx.tenantUsers.updateRole(promoted.userId, 'dispatcher'),
    );

    const refreshed = await services.sessions.refresh(signedIn.tokens.refreshToken);
    expect((await services.tokens.verifyAccessToken(refreshed.accessToken)).role).toBe(
      'dispatcher',
    );
  });

  it('stops somebody whose membership has ended', async () => {
    const leaver = await createMember(services.identity, northwind.id, 'engineer', 'leaver');
    const signedIn = await services.signIn.signInWithPassword({
      email: leaver.email,
      password: leaver.password,
      clientApp: 'mobile',
    });

    await withTenant(northwind.id, (tx) => tx.tenantUsers.softDelete(leaver.userId));

    await expect(services.sessions.refresh(signedIn.tokens.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('ends the session and the offline grant of somebody who left, not only the refresh', async () => {
    // Refusing the refresh is the easy half. The session and the offline grant
    // have to actually be revoked, or the phone keeps opening offline for the
    // rest of the grant's seven days. Both used to be written and then rolled
    // back by the same exception that refused the request, and the test above
    // could not tell.
    const leaver = await createMember(services.identity, northwind.id, 'engineer', 'departed');
    const signedIn = await services.signIn.signInWithPassword({
      email: leaver.email,
      password: leaver.password,
      clientApp: 'mobile',
    });
    await services.sessions.issueOfflineGrant({
      tenantId: northwind.id,
      sessionId: signedIn.tokens.session.id,
      userId: leaver.userId,
      role: 'engineer',
    });

    await withTenant(northwind.id, (tx) => tx.tenantUsers.softDelete(leaver.userId));
    await expect(services.sessions.refresh(signedIn.tokens.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );

    const { session, liveGrants } = await withTenant(northwind.id, async (tx) => ({
      session: await tx.sessions.findById(signedIn.tokens.session.id),
      liveGrants: await tx.offlineGrants.listLiveForUser(leaver.userId),
    }));

    expect(session?.revokedReason).toBe('membership_ended');
    expect(liveGrants).toEqual([]);
  });
});

describe('revocation', () => {
  it('ends a session so its refresh token stops working', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'desktop',
    });

    await expect(
      services.sessions.revoke(northwind.id, signedIn.tokens.session.id, 'revoked_by_admin'),
    ).resolves.toBe(true);

    await expect(services.sessions.refresh(signedIn.tokens.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('lists live sessions and hides revoked ones by default', async () => {
    const person = await createMember(services.identity, northwind.id, 'engineer', 'devices');

    const phone = await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'mobile',
    });
    await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'desktop',
    });

    expect(await services.sessions.list(northwind.id, { userId: person.userId })).toHaveLength(2);

    await services.sessions.revoke(northwind.id, phone.tokens.session.id, 'signed_out');

    expect(await services.sessions.list(northwind.id, { userId: person.userId })).toHaveLength(1);
    expect(
      await services.sessions.list(northwind.id, { userId: person.userId, includeRevoked: true }),
    ).toHaveLength(2);
  });

  it('signs out every device but the one asking', async () => {
    const person = await createMember(services.identity, northwind.id, 'engineer', 'everywhere');

    const keep = await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'desktop',
    });
    await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'mobile',
    });

    const revoked = await services.sessions.revokeAllForUser(
      northwind.id,
      person.userId,
      'signed_out_everywhere',
      { except: keep.tokens.session.id },
    );

    expect(revoked).toBe(1);
    await expect(services.sessions.refresh(keep.tokens.refreshToken)).resolves.toBeDefined();
  });
});

describe('the offline grant', () => {
  it('is issued to the mobile app and lasts seven days', async () => {
    const person = await createMember(services.identity, northwind.id, 'engineer', 'field');
    const start = new Date();
    services.setNow(start);

    const signedIn = await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'mobile',
      deviceLabel: 'Sam’s phone',
    });

    const grant = await services.sessions.issueOfflineGrant({
      tenantId: northwind.id,
      sessionId: signedIn.tokens.session.id,
      userId: person.userId,
      role: 'engineer',
    });

    const days = (grant.expiresAt.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBe(7);

    const claims = await services.tokens.verifyOfflineGrant(grant.token);
    expect(claims.tid).toBe(northwind.id);
    expect(claims.role).toBe('engineer');
    services.setNow(new Date());
  });

  it('is refused to the desktop and web apps', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'desktop',
    });

    await expect(
      services.sessions.issueOfflineGrant({
        tenantId: northwind.id,
        sessionId: signedIn.tokens.session.id,
        userId: dana.userId,
        role: 'owner',
      }),
    ).rejects.toThrow(/mobile app only/u);
  });

  it('is revoked when its session is, so revoking a device really stops it', async () => {
    const person = await createMember(services.identity, northwind.id, 'engineer', 'lost');
    const signedIn = await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'mobile',
    });

    const grant = await services.sessions.issueOfflineGrant({
      tenantId: northwind.id,
      sessionId: signedIn.tokens.session.id,
      userId: person.userId,
      role: 'engineer',
    });

    await services.sessions.revoke(northwind.id, signedIn.tokens.session.id, 'revoked_by_admin');

    const live = await withTenant(northwind.id, (tx) =>
      tx.offlineGrants.listLiveForUser(person.userId),
    );
    expect(live.map((entry) => entry.id)).not.toContain(grant.grant.id);
  });

  it('supersedes the previous grant for the same device', async () => {
    const person = await createMember(services.identity, northwind.id, 'engineer', 'reissued');
    const signedIn = await services.signIn.signInWithPassword({
      email: person.email,
      password: person.password,
      clientApp: 'mobile',
    });

    const first = await services.sessions.issueOfflineGrant({
      tenantId: northwind.id,
      sessionId: signedIn.tokens.session.id,
      userId: person.userId,
      role: 'engineer',
    });
    const second = await services.sessions.issueOfflineGrant({
      tenantId: northwind.id,
      sessionId: signedIn.tokens.session.id,
      userId: person.userId,
      role: 'engineer',
    });

    const live = await withTenant(northwind.id, (tx) =>
      tx.offlineGrants.listLiveForUser(person.userId),
    );

    expect(live.map((entry) => entry.id)).toEqual([second.grant.id]);
    expect(live.map((entry) => entry.id)).not.toContain(first.grant.id);
  });
});

describe('switching companies', () => {
  it('moves somebody who belongs to both, and ends the old session', async () => {
    const email = uniqueEmail('contractor');
    const password = 'a perfectly good passphrase';
    const created = await services.identity.createIdentity(email, password);

    for (const [tenant, role] of [
      [northwind.id, 'engineer'],
      [southgate.id, 'admin'],
    ] as const) {
      await withTenant(tenant, (tx) =>
        tx.tenantUsers.create({
          userId: created.userId,
          email,
          displayName: 'Sam Carter',
          role,
          status: 'active',
        }),
      );
    }

    const signedIn = await services.signIn.signInWithPassword({
      email,
      password,
      clientApp: 'web',
      tenantId: northwind.id,
    });
    expect(signedIn.memberships).toHaveLength(2);

    const principal = await services.tokens.verifyAccessToken(signedIn.tokens.accessToken);
    const switched = await services.signIn.switchTenant(principal, southgate.id, {
      clientApp: 'web',
    });

    const after = await services.tokens.verifyAccessToken(switched.tokens.accessToken);
    expect(after.tenantId).toBe(southgate.id);
    expect(after.role).toBe('admin');

    // The old session is gone: one device, one live session.
    await expect(services.sessions.refresh(signedIn.tokens.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('refuses a company the person does not belong to', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });
    const principal = await services.tokens.verifyAccessToken(signedIn.tokens.accessToken);

    await expect(
      services.signIn.switchTenant(principal, southgate.id, { clientApp: 'web' }),
    ).rejects.toThrow(NotAMemberError);
  });

  it('refuses a company that does not exist', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });
    const principal = await services.tokens.verifyAccessToken(signedIn.tokens.accessToken);

    await expect(
      services.signIn.switchTenant(principal, toTenantId('00000000-0000-4000-8000-00000000ffff'), {
        clientApp: 'web',
      }),
    ).rejects.toThrow(NotAMemberError);
  });

  it('refuses an impersonation session, whose grant covers one company only', async () => {
    // Switching issues a plain session with no grant behind it. Allowed, a
    // super admin impersonating somebody with two companies would hold an
    // unaudited, full-length session in the second one, which ending the grant
    // could not revoke. Refused before membership is even looked at.
    const superAdmin = await createPlatformUser();
    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'Customer asked us to check why switching companies fails',
      clientApp: 'web',
    });
    const principal = await services.tokens.verifyAccessToken(started.tokens.accessToken);

    await expect(
      services.signIn.switchTenant(principal, southgate.id, { clientApp: 'web' }),
    ).rejects.toThrow(ImpersonationDeniedError);
  });
});

describe('a token cannot be edited to reach another company', () => {
  /**
   * P03's first exit criterion, tried three ways.
   *
   * The signature covers `tid`, so editing it invalidates the token. The
   * remaining question is whether anything downstream would accept a token that
   * *is* validly signed but names a company the holder has no business in — and
   * the answer has to be no even for a token this service minted itself.
   */
  it('rejects a token whose tenant claim has been edited', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });

    const [header, payload, signature] = signedIn.tokens.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    claims.tid = southgate.id;

    const edited = [
      header,
      Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url'),
      signature,
    ].join('.');

    await expect(services.tokens.verifyAccessToken(edited)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a token with the signature stripped', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });

    const [header, payload] = signedIn.tokens.accessToken.split('.');
    await expect(services.tokens.verifyAccessToken(`${header}.${payload}.`)).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('does not let one company refresh with another company’s token', async () => {
    // The refresh token names its own company, so pointing it at a different
    // one produces a hash that matches nothing.
    const signedIn = await services.signIn.signInWithPassword({
      email: marek.email,
      password: marek.password,
      clientApp: 'web',
    });

    const [prefix, , secret] = signedIn.tokens.refreshToken.split('.');
    const repointed = [prefix, northwind.id, secret].join('.');

    await expect(services.sessions.refresh(repointed)).rejects.toThrow(InvalidTokenError);
  });
});
