import { mintInvitationToken } from '@integr8/auth';
import {
  type Grant,
  grantSchema,
  type Principal,
  type Role,
  can,
  GRANT_PERMISSIONS,
  roleRank,
  roleSchema,
  toUserId,
} from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { deliverInvitation } from '../../email/deliver.js';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { invitationSchema, iso, memberSchema } from './schemas.js';
import { assertMayAssign } from './member-rules.js';
import { assertMayGiveRole, customRoleBody, customRoleNames } from './roles.js';
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
 * **What "signed out everywhere" means.** Revoking somebody's sessions kills
 * their refresh tokens, so they cannot get a new access token and cannot sign
 * in. An access token already in their hands is refused too: every request
 * checks that its session is still live and the person still an active member
 * (`SessionService.assertLive`). That answer is cached per session for thirty
 * seconds, so a suspended or removed person keeps access for at most that long
 * — on this API process not at all, since revoking here forgets the cache.
 */

const TAGS = ['workspace'];

/** Matches the invitation lifetime elsewhere: long enough to survive a holiday. */
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

function memberBody(
  member: {
    userId: string;
    email: string;
    displayName: string;
    role: string;
    customRoleId: string | null;
    status: string;
    aiEnabled: boolean;
    createdAt: Date;
  },
  grants: readonly Grant[],
  roleNames: ReadonlyMap<string, string> = new Map(),
) {
  return {
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    role: member.role as z.infer<typeof roleSchema>,
    grants: [...grants],
    customRole: customRoleBody(member.customRoleId, roleNames),
    status: member.status as 'invited' | 'active' | 'suspended',
    aiEnabled: member.aiEnabled,
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

/**
 * The second rule: **nobody acts on somebody ranked above them.**
 *
 * The routes below already refuse to *grant* a role above the caller's own.
 * Without this they still let an admin demote, suspend or remove an owner, so
 * long as another owner remained — which turns `member.update_role` into a way
 * of unseating the people who granted it.
 */
function assertOutranks(principal: Principal, target: { role: Role }, action: string): void {
  if (roleRank(target.role) > roleRank(principal.role)) {
    throw forbidden(`You cannot ${action} somebody whose role is above your own.`);
  }
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
    'A built-in `role`, or one of the company’s own roles by `customRoleId` (ADR-0013), which ranks as its base. Nobody may grant a role above their own, for the same reason nobody may invite at one: without that rule, changing a role is a way of promoting yourself; below the owner, nobody gives a company role holding something they do not (422 `role_beyond_own`). Their sessions are ended, so the next token they get carries the new role — but an access token already issued keeps its old role until it lapses, within fifteen minutes.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: z
    .object({ role: roleSchema.optional(), customRoleId: z.uuid().optional() })
    .refine((value) => (value.role === undefined) !== (value.customRoleId === undefined), {
      message: 'Send a role or a company role, not both.',
      path: ['role'],
    }),
  responses: {
    200: { description: 'The person, with their new role.', schema: memberSchema },
    404: { description: 'No such person or company role in this company.' },
    409: { description: 'This is the company’s only owner (`last_owner`).' },
    422: {
      description:
        'A role above the caller’s own (`role_above_own`), or a company role holding what the caller does not (`role_beyond_own`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const tenantId = context.principal.tenantId;
    const target = await memberOr404(tenantId, params.userId);
    assertOutranks(context.principal, target, 'change the role of');
    // Making or unmaking an HR manager is the owner's alone.
    assertMayAssign(context.principal, target.role);

    const companyRole =
      body.customRoleId === undefined
        ? undefined
        : await withTenant(tenantId, (tx) => tx.tenantRoles.find(body.customRoleId!));
    if (body.customRoleId !== undefined && companyRole?.archivedAt !== null) {
      throw notFound('No such role in this company.');
    }
    const role: Role = companyRole?.baseRole ?? body.role!;

    if (companyRole === undefined) {
      assertMayAssign(context.principal, role);
      if (roleRank(role) > roleRank(context.principal.role)) {
        throw unprocessable('role_above_own', 'You cannot give somebody a role above your own.', [
          { field: 'body.role', code: 'role_above_own', message: 'Above your own role.' },
        ]);
      }
    } else {
      assertMayGiveRole(context.principal, companyRole);
    }

    if (role !== 'owner') {
      await assertNotLastOwner(tenantId, params.userId, 'moved off the owner role');
    }

    const updated = await withTenant(tenantId, async (tx) => {
      const member = await tx.tenantUsers.updateRole(
        toUserId(params.userId),
        role,
        companyRole?.id ?? null,
      );
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'member.role_changed',
        resourceType: 'tenant_user',
        resourceId: params.userId,
        metadata: {
          role,
          customRoleId: companyRole?.id ?? null,
          was: member === undefined ? null : target.role,
          wasCustomRoleId: target.customRoleId,
        },
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

    const { grants, names } = await withTenant(tenantId, async (tx) => ({
      grants: await tx.memberGrants.forUser(updated.userId),
      names: await customRoleNames(tx),
    }));
    return { status: 200, body: memberBody(updated, grants, names) };
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
    const target = await memberOr404(tenantId, params.userId);
    assertOutranks(
      context.principal,
      target,
      body.status === 'suspended' ? 'suspend' : 'reactivate',
    );

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

    const { grants, names } = await withTenant(tenantId, async (tx) => ({
      grants: await tx.memberGrants.forUser(updated.userId),
      names: await customRoleNames(tx),
    }));
    return { status: 200, body: memberBody(updated, grants, names) };
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
    const target = await memberOr404(tenantId, params.userId);
    assertOutranks(context.principal, target, 'remove');
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

const grantParams = z.object({ userId: z.uuid(), capability: grantSchema });

/** The member, and their grants after the change, for both grant routes. */
async function grantChange(
  context: RequestContext,
  params: z.infer<typeof grantParams>,
  give: boolean,
) {
  const { principal } = context;
  const tenantId = principal.tenantId;
  const target = await memberOr404(tenantId, params.userId);
  assertOutranks(principal, target, give ? 'give a grant to' : 'take a grant from');
  assertMayAssign(principal, params.capability);
  // Nothing to add when the role already holds all of it.
  if (give && GRANT_PERMISSIONS[params.capability].every((p) => can(target.role, p))) {
    throw conflict('role_holds_grant', 'Their role already includes all of this.');
  }
  if (give && target.status !== 'active') {
    throw conflict('member_not_active', 'Only an active member is given a grant.');
  }
  const grants = await withTenant(tenantId, async (tx) => {
    const changed = give
      ? await tx.memberGrants.give(target.userId, params.capability, principal.userId)
      : await tx.memberGrants.remove(target.userId, params.capability);
    if (changed) {
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: principal.userId,
        actorLabel: principal.userId,
        action: give ? 'member.grant_given' : 'member.grant_removed',
        resourceType: 'tenant_user',
        resourceId: target.userId,
        metadata: { capability: params.capability },
      });
    }
    return { changed, now: await tx.memberGrants.forUser(target.userId) };
  });
  // Taking a grant away ends their sessions, as a role change does, so the
  // next token they get no longer carries it.
  if (!give && grants.changed) {
    await context.services.sessions.revokeAllForUser(
      tenantId,
      toUserId(target.userId),
      'revoked_by_admin',
    );
  }
  const names = await withTenant(tenantId, (tx) => customRoleNames(tx));
  return { status: 200 as const, body: memberBody(target, grants.now, names) };
}

export const giveGrantRoute = defineRoute({
  method: 'put',
  path: '/v1/members/:userId/grants/:capability',
  operationId: 'giveMemberGrant',
  summary: 'Give somebody a capability on top of their role',
  description:
    'An HR manager or inventory manager grant (ADR-0010) on top of whatever role the person has. Only the owner gives the HR one; the owner or an admin gives the inventory one. Takes effect at their next token, within fifteen minutes. 409 `role_holds_grant` when their role already includes it.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: grantParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The person, with their grants.', schema: memberSchema },
    403: { description: 'The HR grant is the owner’s to give.' },
    404: { description: 'No such person in this company.' },
    409: { description: 'Their role already includes it, or they are not active.' },
  },
  handler: async ({ params }, context) => grantChange(context, params, true),
});

export const removeGrantRoute = defineRoute({
  method: 'delete',
  path: '/v1/members/:userId/grants/:capability',
  operationId: 'removeMemberGrant',
  summary: 'Take a capability back',
  description:
    'Only the owner takes the HR grant back; the owner or an admin the inventory one. Their sessions end, so the next token they get no longer carries it.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: grantParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The person, with their grants.', schema: memberSchema },
    403: { description: 'The HR grant is the owner’s to take back.' },
    404: { description: 'No such person in this company.' },
  },
  handler: async ({ params }, context) => grantChange(context, params, false),
});

export const setMemberAiRoute = defineRoute({
  method: 'patch',
  path: '/v1/members/:userId/ai',
  operationId: 'setMemberAi',
  summary: 'Let somebody use the assistant, or stop them',
  description:
    'The company’s own switch for one member (ADR-0001). It can only narrow what the company has: a member switched on still gets nothing while the plan, the override or the app’s switch says off. Owners and admins set it, for members they outrank.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: z.object({ aiEnabled: z.boolean() }),
  responses: {
    200: { description: 'The person, with the switch as it now is.', schema: memberSchema },
    404: { description: 'No such person in this company.' },
  },
  handler: async ({ params, body }, context) => {
    const tenantId = context.principal.tenantId;
    const target = await memberOr404(tenantId, params.userId);
    if (params.userId !== context.principal.userId) {
      assertOutranks(context.principal, target, 'change the assistant access of');
    }

    const { updated, grants, roleNames } = await withTenant(tenantId, async (tx) => {
      const updated = await tx.tenantUsers.setAiEnabled(params.userId, body.aiEnabled);
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: body.aiEnabled ? 'member.ai_enabled' : 'member.ai_disabled',
        resourceType: 'tenant_user',
        resourceId: params.userId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
      return {
        updated,
        grants: await tx.memberGrants.forUser(params.userId),
        roleNames: await customRoleNames(tx),
      };
    });
    if (updated === undefined) {
      throw notFound('No such person in this company.');
    }
    return { status: 200, body: memberBody(updated, grants, roleNames) };
  },
});

export const memberRoutes = [
  resendInvitationRoute,
  setMemberAiRoute,
  changeMemberRoleRoute,
  setMemberStatusRoute,
  removeMemberRoute,
  giveGrantRoute,
  removeGrantRoute,
];
