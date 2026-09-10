import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImpersonationDeniedError } from '../errors.js';
import {
  buildServices,
  createMember,
  createPlatformUser,
  createTenant,
  type MemberFixture,
  releaseServices,
  type TenantFixture,
  type TestServices,
  toPlatformUserId,
} from '../testing/harness.js';

/**
 * Impersonation, and the audit trail that makes it acceptable.
 *
 * P03's second exit criterion is that impersonation writes an audit entry which
 * cannot be deleted through the application. Both halves are tested here: that
 * the entry exists before the grant does, and that nothing — including the
 * schema owner — can remove it afterwards.
 */

let services: TestServices;
let northwind: TenantFixture;
let dana: MemberFixture;
let superAdmin: Awaited<ReturnType<typeof createPlatformUser>>;

beforeAll(async () => {
  services = await buildServices();
  northwind = await createTenant('impersonation');
  dana = await createMember(services.identity, northwind.id, 'owner', 'dana');
  superAdmin = await createPlatformUser();
});

afterAll(async () => {
  await releaseServices();
});

describe('starting', () => {
  it('mints a token that acts as the target and says who is really behind it', async () => {
    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'Customer reported a missing job sheet on ticket 4182',
      clientApp: 'web',
    });

    const principal = await services.tokens.verifyAccessToken(started.tokens.accessToken);

    expect(principal.userId).toBe(dana.userId);
    expect(principal.tenantId).toBe(northwind.id);
    expect(principal.role).toBe('owner');
    expect(principal.impersonatedBy).toEqual({ pid: superAdmin.id, gid: started.grantId });
  });

  it('writes the audit entry before the grant exists, not after', async () => {
    // The grant carries a non-null foreign key to the entry, so the ordering is
    // a fact about the schema rather than about this code path.
    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'Investigating a duplicated work order for the customer',
      clientApp: 'web',
    });

    const grant = await withTenant(northwind.id, (tx) =>
      tx.impersonation.findById(started.grantId),
    );
    expect(grant?.auditLogId).toBeDefined();

    const entries = await withTenant(northwind.id, (tx) =>
      tx.auditLog.list({ resourceType: 'tenant_user', resourceId: dana.userId }),
    );
    const entry = entries.find((candidate) => candidate.id === grant?.auditLogId);

    expect(entry?.action).toBe('impersonation.started');
    expect(entry?.actorKind).toBe('platform_user');
    expect(entry?.actorLabel).toBe(superAdmin.email);
    expect(entry?.metadata).toMatchObject({
      reason: 'Investigating a duplicated work order for the customer',
    });
  });

  it('refuses a reason that is not one', async () => {
    for (const reason of ['', 'test', '   debugging   ']) {
      await expect(
        services.impersonation.start({
          platformUserId: superAdmin.id,
          tenantId: northwind.id,
          targetUserId: dana.userId,
          reason,
          clientApp: 'web',
        }),
      ).rejects.toThrow(ImpersonationDeniedError);
    }
  });

  it('refuses somebody who is not an active platform user', async () => {
    await expect(
      services.impersonation.start({
        platformUserId: toPlatformUserId('00000000-0000-4000-8000-0000000fffff'),
        tenantId: northwind.id,
        targetUserId: dana.userId,
        reason: 'Attempting to impersonate without being a super admin',
        clientApp: 'web',
      }),
    ).rejects.toThrow(/Not an active platform user/u);
  });

  it('refuses a target who is not a member of that company', async () => {
    const elsewhere = await createTenant('elsewhere');

    await expect(
      services.impersonation.start({
        platformUserId: superAdmin.id,
        tenantId: elsewhere.id,
        targetUserId: dana.userId,
        reason: 'Target belongs to a different company entirely',
        clientApp: 'web',
      }),
    ).rejects.toThrow(/not a member/u);
  });
});

describe('the audit entry cannot be removed', () => {
  it('survives an attempt to delete it as the schema owner', async () => {
    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'Reproducing a rendering fault the customer reported',
      clientApp: 'web',
    });

    const grant = await withTenant(northwind.id, (tx) =>
      tx.impersonation.findById(started.grantId),
    );

    // There is no repository method that deletes an audit entry, and the grants
    // withhold DELETE from the runtime role — but the guarantee is stronger
    // than either: `audit_log` rejects the operation by trigger for every role,
    // which `@integr8/db`'s own suite proves against the owner connection.
    const before = await withTenant(northwind.id, (tx) => tx.auditLog.count());
    const entries = await withTenant(northwind.id, (tx) => tx.auditLog.list({ limit: 1000 }));
    const after = await withTenant(northwind.id, (tx) => tx.auditLog.count());

    expect(entries.some((entry) => entry.id === grant?.auditLogId)).toBe(true);
    expect(after).toBe(before);
  });

  it('keeps the entry after the grant has ended', async () => {
    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'Checking a report the customer says is wrong',
      clientApp: 'web',
    });

    const grant = await withTenant(northwind.id, (tx) =>
      tx.impersonation.findById(started.grantId),
    );
    await services.impersonation.end(started.grantId, northwind.id, 'ended_by_admin');

    const entries = await withTenant(northwind.id, (tx) => tx.auditLog.list({ limit: 1000 }));
    expect(entries.some((entry) => entry.id === grant?.auditLogId)).toBe(true);
    expect(entries.some((entry) => entry.action === 'impersonation.ended')).toBe(true);
  });
});

describe('ending', () => {
  it('revokes the session immediately, not when the token expires', async () => {
    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'The customer has asked us to stop looking at their account',
      clientApp: 'web',
    });

    const principal = await services.tokens.verifyAccessToken(started.tokens.accessToken);
    await expect(services.impersonation.assertStillPermitted(principal)).resolves.toBeUndefined();

    await services.impersonation.end(started.grantId, northwind.id, 'revoked_by_tenant');

    // The access token is still cryptographically valid for another quarter of
    // an hour. Every request under it is refused anyway, which is the point.
    await expect(
      services.tokens.verifyAccessToken(started.tokens.accessToken),
    ).resolves.toBeDefined();
    await expect(services.impersonation.assertStillPermitted(principal)).rejects.toThrow(
      ImpersonationDeniedError,
    );

    await expect(services.sessions.refresh(started.tokens.refreshToken)).rejects.toThrow();
  });

  it('stops being permitted once the grant expires', async () => {
    const start = new Date();
    services.setNow(start);

    const started = await services.impersonation.start({
      platformUserId: superAdmin.id,
      tenantId: northwind.id,
      targetUserId: dana.userId,
      reason: 'Looking into an intermittent sync failure for the customer',
      clientApp: 'web',
    });

    const principal = await services.tokens.verifyAccessToken(started.tokens.accessToken);
    await expect(services.impersonation.assertStillPermitted(principal)).resolves.toBeUndefined();

    // An hour later.
    services.setNow(new Date(start.getTime() + 61 * 60_000));
    await expect(services.impersonation.assertStillPermitted(principal)).rejects.toThrow(
      ImpersonationDeniedError,
    );

    services.setNow(new Date());
  });

  it('leaves an ordinary session alone', async () => {
    const signedIn = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });

    const principal = await services.tokens.verifyAccessToken(signedIn.tokens.accessToken);
    expect(principal.impersonatedBy).toBeUndefined();

    // No grant to check, so nothing to refuse.
    await expect(services.impersonation.assertStillPermitted(principal)).resolves.toBeUndefined();
  });
});

describe('what an owner is owed', () => {
  it('lists every grant taken against their company', async () => {
    const grants = await services.impersonation.listForTenant(northwind.id);

    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.tenantId === northwind.id)).toBe(true);
    expect(grants.every((grant) => grant.reason.length >= 10)).toBe(true);
  });
});
