import { PermissionDeniedError, type Principal } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationInvalidError, WeakPasswordError } from '../errors.js';
import {
  buildServices,
  createMember,
  createTenant,
  type MemberFixture,
  releaseServices,
  type TenantFixture,
  type TestServices,
  uniqueEmail,
} from '../testing/harness.js';

/**
 * Invitations: issuing them, accepting them, and the several ways they must
 * fail.
 */

let services: TestServices;
let northwind: TenantFixture;
let southgate: TenantFixture;
let owner: MemberFixture;
let ownerPrincipal: Principal;
let engineerPrincipal: Principal;

async function principalFor(member: MemberFixture): Promise<Principal> {
  const signedIn = await services.signIn.signInWithPassword({
    email: member.email,
    password: member.password,
    clientApp: 'web',
  });
  return services.tokens.verifyAccessToken(signedIn.tokens.accessToken);
}

beforeAll(async () => {
  services = await buildServices();
  northwind = await createTenant('invites');
  southgate = await createTenant('invites-other');

  owner = await createMember(services.identity, northwind.id, 'owner', 'owner');
  const engineer = await createMember(services.identity, northwind.id, 'engineer', 'engineer');

  ownerPrincipal = await principalFor(owner);
  engineerPrincipal = await principalFor(engineer);
});

afterAll(async () => {
  await releaseServices();
});

describe('issuing', () => {
  it('creates an invitation and returns the token exactly once', async () => {
    const email = uniqueEmail('invitee');
    const { invitation, token } = await services.invitations.invite(ownerPrincipal, {
      email,
      role: 'engineer',
    });

    expect(invitation.email).toBe(email);
    expect(invitation.role).toBe('engineer');
    expect(token).toMatch(/^i8i1\./u);

    // Only the hash is kept, so the token cannot be recovered from the row.
    const stored = await withTenant(northwind.id, (tx) => tx.invitations.findLiveByEmail(email));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('records who invited whom', async () => {
    const email = uniqueEmail('audited');
    const { invitation } = await services.invitations.invite(ownerPrincipal, {
      email,
      role: 'viewer',
    });

    const entries = await withTenant(northwind.id, (tx) =>
      tx.auditLog.list({ resourceType: 'invitation', resourceId: invitation.id }),
    );

    expect(entries[0]?.action).toBe('invitation.created');
    expect(entries[0]?.metadata).toMatchObject({ email, role: 'viewer' });
  });

  it('refuses somebody without the permission', async () => {
    await expect(
      services.invitations.invite(engineerPrincipal, {
        email: uniqueEmail('nope'),
        role: 'viewer',
      }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('refuses to grant a role the inviter does not hold', async () => {
    // Otherwise `member.invite` is `member.promote_self`: an admin invites
    // their own second address as an owner and the hierarchy is decorative.
    const admin = await createMember(services.identity, northwind.id, 'admin', 'admin');
    const adminPrincipal = await principalFor(admin);

    await expect(
      services.invitations.invite(adminPrincipal, {
        email: uniqueEmail('escalation'),
        role: 'owner',
      }),
    ).rejects.toThrow(/cannot invite somebody as owner/u);

    await expect(
      services.invitations.invite(adminPrincipal, {
        email: uniqueEmail('sideways'),
        role: 'admin',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses an address that is already a member', async () => {
    await expect(
      services.invitations.invite(ownerPrincipal, { email: owner.email, role: 'viewer' }),
    ).rejects.toThrow(/already a member/u);
  });

  it('replaces an outstanding invitation rather than accumulating them', async () => {
    const email = uniqueEmail('reinvited');
    const first = await services.invitations.invite(ownerPrincipal, { email, role: 'viewer' });
    const second = await services.invitations.invite(ownerPrincipal, { email, role: 'engineer' });

    const live = await withTenant(northwind.id, (tx) => tx.invitations.findLiveByEmail(email));
    expect(live?.id).toBe(second.invitation.id);

    // The superseded token no longer works.
    await expect(
      services.invitations.accept({
        token: first.token,
        password: 'a perfectly good passphrase',
        displayName: 'Replaced',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvitationInvalidError);
  });
});

describe('accepting', () => {
  it('creates the membership at the invited role and signs the person in', async () => {
    const email = uniqueEmail('accepts');
    const { token } = await services.invitations.invite(ownerPrincipal, {
      email,
      role: 'dispatcher',
    });

    const accepted = await services.invitations.accept({
      token,
      password: 'a perfectly good passphrase',
      displayName: 'New Dispatcher',
      clientApp: 'web',
    });

    expect(accepted.tenantId).toBe(northwind.id);

    const principal = await services.tokens.verifyAccessToken(accepted.tokens.accessToken);
    expect(principal.role).toBe('dispatcher');
    expect(principal.tenantId).toBe(northwind.id);

    const member = await withTenant(northwind.id, (tx) => tx.tenantUsers.findByEmail(email));
    expect(member?.role).toBe('dispatcher');
    expect(member?.status).toBe('active');
  });

  it('cannot be redeemed twice', async () => {
    const email = uniqueEmail('twice');
    const { token } = await services.invitations.invite(ownerPrincipal, { email, role: 'viewer' });

    await services.invitations.accept({
      token,
      password: 'a perfectly good passphrase',
      displayName: 'First',
      clientApp: 'web',
    });

    await expect(
      services.invitations.accept({
        token,
        password: 'a perfectly good passphrase',
        displayName: 'Second',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvitationInvalidError);
  });

  it('cannot be redeemed against a different company', async () => {
    // The company comes from the token, and there is no parameter in which to
    // name another — so the closest an attacker can get is editing the token,
    // which changes its hash.
    const email = uniqueEmail('cross');
    const { token } = await services.invitations.invite(ownerPrincipal, { email, role: 'viewer' });

    const [prefix, , secret] = token.split('.');
    const repointed = [prefix, southgate.id, secret].join('.');

    await expect(
      services.invitations.accept({
        token: repointed,
        password: 'a perfectly good passphrase',
        displayName: 'Intruder',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvitationInvalidError);

    const member = await withTenant(southgate.id, (tx) => tx.tenantUsers.findByEmail(email));
    expect(member).toBeUndefined();
  });

  it('refuses an expired invitation', async () => {
    const start = new Date();
    services.setNow(start);

    const { token } = await services.invitations.invite(ownerPrincipal, {
      email: uniqueEmail('stale'),
      role: 'viewer',
    });

    services.setNow(new Date(start.getTime() + 8 * 24 * 60 * 60_000));

    await expect(
      services.invitations.accept({
        token,
        password: 'a perfectly good passphrase',
        displayName: 'Too Late',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvitationInvalidError);

    services.setNow(new Date());
  });

  it('refuses an invented or malformed token', async () => {
    for (const token of ['', 'nonsense', `i8i1.${northwind.id}.invented`]) {
      await expect(
        services.invitations.accept({
          token,
          password: 'a perfectly good passphrase',
          displayName: 'Nobody',
          clientApp: 'web',
        }),
      ).rejects.toThrow(InvitationInvalidError);
    }
  });

  it('applies the password policy, and creates nothing when it fails', async () => {
    const email = uniqueEmail('weak');
    const { token, invitation } = await services.invitations.invite(ownerPrincipal, {
      email,
      role: 'viewer',
    });

    await expect(
      services.invitations.accept({
        token,
        password: 'password123',
        displayName: 'Weak',
        clientApp: 'web',
      }),
    ).rejects.toThrow(WeakPasswordError);

    // The invitation is still live, and no membership was created.
    const live = await withTenant(northwind.id, (tx) => tx.invitations.findLiveByEmail(email));
    expect(live?.id).toBe(invitation.id);
    await expect(
      withTenant(northwind.id, (tx) => tx.tenantUsers.findByEmail(email)),
    ).resolves.toBeUndefined();
  });
});

describe('withdrawing', () => {
  it('stops a token that has been handed out', async () => {
    const email = uniqueEmail('withdrawn');
    const { token, invitation } = await services.invitations.invite(ownerPrincipal, {
      email,
      role: 'engineer',
    });

    await expect(services.invitations.revoke(ownerPrincipal, invitation.id)).resolves.toBe(true);

    await expect(
      services.invitations.accept({
        token,
        password: 'a perfectly good passphrase',
        displayName: 'Withdrawn',
        clientApp: 'web',
      }),
    ).rejects.toThrow(InvitationInvalidError);
  });

  it('refuses somebody without the permission', async () => {
    const { invitation } = await services.invitations.invite(ownerPrincipal, {
      email: uniqueEmail('guarded'),
      role: 'viewer',
    });

    await expect(services.invitations.revoke(engineerPrincipal, invitation.id)).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('is idempotent', async () => {
    const { invitation } = await services.invitations.invite(ownerPrincipal, {
      email: uniqueEmail('twice-revoked'),
      role: 'viewer',
    });

    await expect(services.invitations.revoke(ownerPrincipal, invitation.id)).resolves.toBe(true);
    await expect(services.invitations.revoke(ownerPrincipal, invitation.id)).resolves.toBe(false);
  });
});

describe('listing', () => {
  it('shows only this company’s pending invitations', async () => {
    const pending = await services.invitations.listPending(ownerPrincipal);

    expect(pending.every((invitation) => invitation.tenantId === northwind.id)).toBe(true);
    expect(pending.every((invitation) => invitation.acceptedAt === null)).toBe(true);
    expect(pending.every((invitation) => invitation.revokedAt === null)).toBe(true);
  });

  it('refuses somebody without the permission', async () => {
    await expect(services.invitations.listPending(engineerPrincipal)).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});
