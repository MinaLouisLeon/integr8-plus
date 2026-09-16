import { mintInvitationToken } from '@integr8/auth';
import { roleRank, roleSchema, toUserId } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { deliverInvitation } from '../../email/deliver.js';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { invitationSchema, iso, memberSchema } from './schemas.js';
import { inviterName } from './workspace.js';

/**
 * Managing the people already here (P18).
 *
 * Inviting somebody has worked since P07. Everything you do *afterwards* —
 * change what they may do, suspend them, remove them, send the invitation
 * again — had permissions defined in `@integr8/core` and methods on the
 * repository, and no route joining the two. This file is that join.
 *
 * Separate from `workspace.ts` because that file is the company's own view of
 * itself — who am I, my sessions, the member list — and these are actions taken
 * on somebody else, each with a way of going badly wrong.
 *
 * **What "signed out everywhere" does and does not mean.** Revoking somebody's
 * sessions kills their refresh tokens, so they cannot get a new access token
 * and cannot sign in. It does **not** invalidate an access token already in
 * their hands: a tenant access token is a stateless JWT and the request
 * pipeline re-reads the database only for platform sessions and impersonation
 * grants. So a suspended or removed person keeps whatever access they had for
 * up to `AUTH_ACCESS_TOKEN_TTL_SECONDS` — fifteen minutes by default.
 *
 * That is a deliberate trade already made elsewhere in this system (it is why
 * the company suspension check is cached for a minute rather than read every
 * time), and it is written here rather than hidden because "remove somebody who
 * has just been dismissed" is exactly the case where fifteen minutes matters.
 * Closing it means a per-request membership check; that is a decision with a
 * cost on every request, and it is not one to make quietly inside P18.
 */

const TAGS = ['workspace'];

/** Matches the invitation lifetime elsewhere: long enough to survive a holiday. */
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

function memberBody(member: {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: Date;
}) {
  return {
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    role: member.role as z.infer<typeof roleSchema>,
    status: member.status as 'invited' | 'active' | 'suspended',
    createdAt: iso(member.createdAt),
  };
}

/**
 * The rule every route here obeys: **a company must keep an owner.**
 *
 * Demoting, suspending or removing the last active owner leaves a company
 * nobody can administer, pay for or close — recoverable only by a super admin,
 * and only once somebody notices. So it is refused, including when the owner is
 * doing it to themselves, which is how it actually happens: somebody tidies up
 * their own account on the way out of the business.
 */
async function assertNotLastOwner(tenantId: string, userId: string, action: string): Promise<void> {
  const members = await withTenant(tenantId, (tx) => tx.tenantUsers.list());
  const target = members.find((member) => member.userId === userId);
  if (target?.role !== 'owner' || target.status !== 'active') {
    return;
  }

  const owners = members.filter((member) => member.role === 'owner' && member.status === 'active');
  if (owners.length > 1) {
    return;
  }

  throw conflict(
    'last_owner',
    'This is the only owner of the company, so they cannot be ' +
      action +
      '. Make somebody else an owner first.',
  );
}

async function memberOr404(tenantId: string, userId: string) {
  const member = await withTenant(tenantId, (tx) => tx.tenantUsers.findByUserId(toUserId(userId)));
  if (member === undefined) {
    throw notFound('No such person in this company');
  }
  return member;
}

export const resendInvitationRoute = defineRoute({
  method: 'post',
  path: '/v1/members/invitations/:invitationId/resend',
  operationId: 'resendMemberInvitation',
  summary: 'Send an invitation again',
  description:
    'Withdraws the old invitation and issues a new one to the same address and role, then emails it. A new token rather than the old one: the reason for resending is usually that the first link went astray, and a link sitting in the wrong mailbox should stop working.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.invite',
  params: z.object({ invitationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'A new invitation, sent.', schema: invitationSchema },
    404: { description: 'No such invitation, or it has been accepted or withdrawn.' },
  },
  handler: async ({ params }, context) => {
    const tenantId = context.principal.tenantId;
    const actor = toUserId(context.principal.userId);

    const reissued = await withTenant(tenantId, async (tx) => {
      const pending = (await tx.invitations.listPending()).find(
        (invitation) => invitation.id === params.invitationId,
      );
      if (pending === undefined) {
        return undefined;
      }

      await tx.invitations.revoke(pending.id, actor);

      const secret = mintInvitationToken(tenantId);
      const created = await tx.invitations.create({
        email: pending.email,
        role: pending.role,
        invitedByUserId: actor,
        tokenHash: secret.hash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
      });

      return { invitation: created, token: secret.token };
    });

    if (reissued === undefined) {
      throw notFound('No pending invitation with that id');
    }

    const delivery = await deliverInvitation({
      sender: context.services.email,
      config: context.config,
      logger: context.logger,
      tenantId,
      email: reissued.invitation.email,
      token: reissued.token,
      invitedBy: await inviterName(context.principal),
      expiresAt: reissued.invitation.expiresAt,
    });

    return {
      status: 200,
      body: {
        id: reissued.invitation.id,
        email: reissued.invitation.email,
        role: reissued.invitation.role,
        createdAt: iso(reissued.invitation.createdAt),
        expiresAt: iso(reissued.invitation.expiresAt),
        emailed: delivery.sent,
      },
    };
  },
});

export const changeMemberRoleRoute = defineRoute({
  method: 'patch',
  path: '/v1/members/:userId/role',
  operationId: 'changeMemberRole',
  summary: 'Change what somebody may do',
  description:
    'Nobody may grant a role above their own, for the same reason nobody may invite at one: without that rule, changing a role is a way of promoting yourself. Their sessions are ended, so the next token they get carries the new role — but an access token already issued keeps its old role until it lapses, within fifteen minutes.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: z.object({ role: roleSchema }),
  responses: {
    200: { description: 'The person, with their new role.', schema: memberSchema },
    404: { description: 'No such person in this company.' },
    409: { description: 'This is the company’s only owner (`last_owner`).' },
    422: { description: 'A role above the caller’s own (`role_above_own`).' },
  },
  handler: async ({ params, body }, context) => {
    const tenantId = context.principal.tenantId;
    await memberOr404(tenantId, params.userId);

    if (roleRank(body.role) > roleRank(context.principal.role)) {
      throw unprocessable('role_above_own', 'You cannot give somebody a role above your own.', [
        { field: 'body.role', code: 'role_above_own', message: 'Above your own role.' },
      ]);
    }

    if (body.role !== 'owner') {
      await assertNotLastOwner(tenantId, params.userId, 'moved off the owner role');
    }

    const updated = await withTenant(tenantId, async (tx) => {
      const member = await tx.tenantUsers.updateRole(toUserId(params.userId), body.role);
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'member.role_changed',
        resourceType: 'tenant_user',
        resourceId: params.userId,
        metadata: { role: body.role, was: member === undefined ? null : member.role },
      });
      return member;
    });

    if (updated === undefined) {
      throw notFound('No such person in this company');
    }

    // `revoked_by_admin` rather than a reason of its own: the set of reasons is
    // a database enum, and one more value for this would be a migration to
    // make a log line read better.
    await context.services.sessions.revokeAllForUser(
      tenantId,
      toUserId(params.userId),
      'revoked_by_admin',
    );

    return { status: 200, body: memberBody(updated) };
  },
});

export const setMemberStatusRoute = defineRoute({
  method: 'patch',
  path: '/v1/members/:userId/status',
  operationId: 'setMemberStatus',
  summary: 'Suspend somebody, or let them back in',
  description:
    'Suspending refuses them entry and keeps everything they have ever done. It is the reversible half of removing somebody: the right answer for a lost phone or somebody between jobs. Their sessions are ended, so they cannot sign in or refresh — but see the note on this file about the fifteen minutes an access token already in their hands stays valid.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.suspend',
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: z.object({ status: z.enum(['active', 'suspended']) }),
  responses: {
    200: { description: 'The person, with their new status.', schema: memberSchema },
    404: { description: 'No such person in this company.' },
    409: { description: 'This is the company’s only owner (`last_owner`).' },
  },
  handler: async ({ params, body }, context) => {
    const tenantId = context.principal.tenantId;
    await memberOr404(tenantId, params.userId);

    if (body.status === 'suspended') {
      await assertNotLastOwner(tenantId, params.userId, 'suspended');
    }

    const updated = await withTenant(tenantId, async (tx) => {
      const member = await tx.tenantUsers.updateStatus(toUserId(params.userId), body.status);
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: body.status === 'suspended' ? 'member.suspended' : 'member.reactivated',
        resourceType: 'tenant_user',
        resourceId: params.userId,
      });
      return member;
    });

    if (updated === undefined) {
      throw notFound('No such person in this company');
    }

    if (body.status === 'suspended') {
      await context.services.sessions.revokeAllForUser(
        tenantId,
        toUserId(params.userId),
        'membership_ended',
      );
    }

    return { status: 200, body: memberBody(updated) };
  },
});

export const removeMemberRoute = defineRoute({
  method: 'delete',
  path: '/v1/members/:userId',
  operationId: 'removeMember',
  summary: 'Remove somebody from this company',
  description:
    'Soft, and deliberately so: everything they filled in, signed and submitted stays, and the history still names them. What goes is their way in and the seat they were taking up. As with suspending, an access token already issued outlives this by up to fifteen minutes.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.remove',
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Removed.', schema: z.object({ removed: z.boolean() }) },
    404: { description: 'No such person in this company.' },
    409: { description: 'This is the company’s only owner (`last_owner`).' },
  },
  handler: async ({ params }, context) => {
    const tenantId = context.principal.tenantId;
    await memberOr404(tenantId, params.userId);
    await assertNotLastOwner(tenantId, params.userId, 'removed');

    const removed = await withTenant(tenantId, async (tx) => {
      const done = await tx.tenantUsers.softDelete(toUserId(params.userId));
      if (done) {
        await tx.auditLog.append({
          actorKind: 'tenant_user',
          actorId: context.principal.userId,
          actorLabel: context.principal.userId,
          action: 'member.removed',
          resourceType: 'tenant_user',
          resourceId: params.userId,
        });
      }
      return done;
    });

    // Whether or not the row changed: a session belonging to somebody who is
    // no longer a member must not outlive the membership.
    await context.services.sessions.revokeAllForUser(
      tenantId,
      toUserId(params.userId),
      'membership_ended',
    );

    return { status: 200, body: { removed } };
  },
});

export const memberRoutes = [
  resendInvitationRoute,
  changeMemberRoleRoute,
  setMemberStatusRoute,
  removeMemberRoute,
];
