import { permissionsFor, roleSchema, toUserId } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import {
  acceptedSchema,
  invitationSchema,
  iso,
  isoOrNull,
  listSchema,
  memberSchema,
  meSchema,
  revokedSchema,
  sessionSchema,
} from './schemas.js';

/**
 * Who I am, my devices, and the people in this company.
 *
 * The first real surface, and the one the exit criteria are demonstrated
 * against: `POST /v1/members/invitations` is a mutation with a durable effect,
 * which is what makes the idempotency claim testable rather than theoretical.
 */

export const meRoute = defineRoute({
  method: 'get',
  path: '/v1/me',
  operationId: 'getMe',
  summary: 'The signed-in person and what they may do',
  description:
    'Includes the resolved permission list so a client can hide what it would be refused. That is presentation, not a control: every request is checked again on arrival.',
  tags: ['workspace'],
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The current principal.', schema: meSchema },
    404: { description: 'The membership behind this token no longer exists.' },
  },
  handler: async (_input, context) => {
    const member = await withTenant(context.principal.tenantId, (tx) =>
      tx.tenantUsers.findByUserId(context.principal.userId),
    );

    if (member === undefined) {
      // The token is valid but the membership has gone — removed while this
      // access token was still in its fifteen minutes.
      throw notFound('This membership no longer exists.');
    }

    return {
      status: 200,
      body: {
        userId: member.userId,
        tenantId: member.tenantId,
        email: member.email,
        displayName: member.displayName,
        role: member.role,
        permissions: permissionsFor(member.role),
        ...(context.principal.impersonatedBy === undefined
          ? {}
          : {
              impersonatedBy: {
                platformUserId: context.principal.impersonatedBy.pid,
                grantId: context.principal.impersonatedBy.gid,
              },
            }),
      },
    };
  },
});

export const listSessionsRoute = defineRoute({
  method: 'get',
  path: '/v1/sessions',
  operationId: 'listSessions',
  summary: 'Devices signed in to this company',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'session.read',
  params: noSchema,
  query: z.object({
    /** Mine only, by default: "my devices" is the common question. */
    scope: z.enum(['mine', 'company']).default('mine'),
    includeRevoked: z.stringbool().default(false),
  }),
  body: noSchema,
  responses: { 200: { description: 'Sessions.', schema: listSchema(sessionSchema) } },
  handler: async ({ query }, context) => {
    const sessions = await context.services.sessions.list(context.principal.tenantId, {
      ...(query.scope === 'mine' ? { userId: context.principal.userId } : {}),
      includeRevoked: query.includeRevoked,
    });

    return {
      status: 200,
      body: {
        items: sessions.map((session) => ({
          id: session.id,
          clientApp: session.clientApp,
          deviceLabel: session.deviceLabel,
          ipAddress: session.ipAddress,
          createdAt: iso(session.createdAt),
          lastSeenAt: iso(session.lastSeenAt),
          expiresAt: iso(session.expiresAt),
          revokedAt: isoOrNull(session.revokedAt),
          revokedReason: session.revokedReason,
          isCurrent: session.id === context.principal.sessionId,
        })),
      },
    };
  },
});

export const revokeSessionRoute = defineRoute({
  method: 'delete',
  path: '/v1/sessions/:sessionId',
  operationId: 'revokeSession',
  summary: 'Sign a device out',
  description:
    'Revokes the session and any offline grant issued to it. A device with an offline grant would otherwise keep working for up to a week after being "signed out".',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'session.revoke',
  params: z.object({ sessionId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'Whether a live session was revoked.', schema: revokedSchema } },
  handler: async ({ params }, context) => {
    const revoked = await context.services.sessions.revoke(
      context.principal.tenantId,
      params.sessionId,
      'revoked_by_admin',
    );

    return { status: 200, body: { revoked } };
  },
});

export const listMembersRoute = defineRoute({
  method: 'get',
  path: '/v1/members',
  operationId: 'listMembers',
  summary: 'People in this company',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'member.read',
  params: noSchema,
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  body: noSchema,
  responses: { 200: { description: 'Members.', schema: listSchema(memberSchema) } },
  handler: async ({ query }, context) => {
    const members = await withTenant(context.principal.tenantId, (tx) =>
      tx.tenantUsers.list({ limit: query.limit }),
    );

    return {
      status: 200,
      body: {
        items: members.map((member) => ({
          userId: member.userId,
          email: member.email,
          displayName: member.displayName,
          role: member.role,
          status: member.status,
          createdAt: iso(member.createdAt),
        })),
      },
    };
  },
});

export const inviteMemberRoute = defineRoute({
  method: 'post',
  path: '/v1/members/invitations',
  operationId: 'inviteMember',
  summary: 'Invite somebody to this company',
  description:
    'Sends an invitation at a fixed role. Nobody may invite at a role above their own. Honours `Idempotency-Key`: retrying after a dropped connection returns the original invitation rather than sending a second one.',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'member.invite',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.string().min(3).max(320),
    role: roleSchema,
  }),
  responses: {
    201: { description: 'The invitation was created.', schema: invitationSchema },
    422: { description: 'Already a member, or a role above the inviter’s own.' },
  },
  handler: async ({ body }, context) => {
    const { invitation } = await context.services.invitations.invite(context.principal, {
      email: body.email,
      role: body.role,
    });

    // The token is deliberately absent from the response. It goes to the
    // invitee's mailbox and nowhere else: returning it here would let anyone
    // who can invite also accept on that person's behalf.
    return {
      status: 201,
      body: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        createdAt: iso(invitation.createdAt),
        expiresAt: iso(invitation.expiresAt),
      },
    };
  },
});

export const listInvitationsRoute = defineRoute({
  method: 'get',
  path: '/v1/members/invitations',
  operationId: 'listInvitations',
  summary: 'Invitations not yet accepted',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'invitation.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'Pending invitations.', schema: listSchema(invitationSchema) } },
  handler: async (_input, context) => {
    const invitations = await context.services.invitations.listPending(context.principal);

    return {
      status: 200,
      body: {
        items: invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          createdAt: iso(invitation.createdAt),
          expiresAt: iso(invitation.expiresAt),
        })),
      },
    };
  },
});

export const revokeInvitationRoute = defineRoute({
  method: 'delete',
  path: '/v1/members/invitations/:invitationId',
  operationId: 'revokeInvitation',
  summary: 'Withdraw an invitation',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'invitation.revoke',
  params: z.object({ invitationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Whether a live invitation was withdrawn.', schema: revokedSchema },
  },
  handler: async ({ params }, context) => {
    const revoked = await context.services.invitations.revoke(
      context.principal,
      params.invitationId,
    );

    return { status: 200, body: { revoked } };
  },
});

export const acceptInvitationRoute = defineRoute({
  method: 'post',
  path: '/v1/invitations/accept',
  operationId: 'acceptInvitation',
  summary: 'Accept an invitation and sign in',
  description:
    'Public, because the invitee has no session yet. The company comes from the token: there is no parameter in which to name a different one.',
  tags: ['authentication'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    token: z.string().min(1).max(512),
    displayName: z.string().min(1).max(120),
    password: z.string().min(1).max(200).optional(),
    clientApp: z.enum(['web', 'desktop', 'mobile']).default('web'),
  }),
  responses: {
    200: { description: 'Accepted, and signed in.', schema: acceptedSchema },
    422: { description: 'The invitation is unknown, spent, withdrawn or expired.' },
  },
  handler: async ({ body }, context) => {
    await context.services.invitations.accept({
      token: body.token,
      ...(body.password === undefined ? {} : { password: body.password }),
      displayName: body.displayName,
      clientApp: body.clientApp,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    // Accepting does sign the person in, but the tokens are not returned here.
    // The invitation token travels by email and may sit in a mailbox, a proxy
    // log or a screenshot; handing back a live session in exchange would make
    // every one of those a way in. The client signs in normally afterwards.
    return { status: 200, body: { accepted: true } };
  },
});

export const revokeMemberSessionsRoute = defineRoute({
  method: 'post',
  path: '/v1/members/:userId/sessions/revoke',
  operationId: 'revokeMemberSessions',
  summary: 'Sign one person out of every device',
  description: 'What an admin reaches for when somebody loses a phone or leaves.',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'session.revoke',
  idempotent: true,
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'How many sessions were revoked.',
      schema: z.object({ revoked: z.number() }),
    },
  },
  handler: async ({ params }, context) => {
    const revoked = await context.services.sessions.revokeAllForUser(
      context.principal.tenantId,
      toUserId(params.userId),
      'revoked_by_admin',
    );

    return { status: 200, body: { revoked } };
  },
});

export const workspaceRoutes = [
  meRoute,
  listSessionsRoute,
  revokeSessionRoute,
  listMembersRoute,
  inviteMemberRoute,
  listInvitationsRoute,
  revokeInvitationRoute,
  acceptInvitationRoute,
  revokeMemberSessionsRoute,
];
