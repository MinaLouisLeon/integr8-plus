import { mintInvitationToken } from '@integr8/auth';
import { toTenantId, toUserId } from '@integr8/core';
import { getAuthDataSource, getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { deliverInvitation } from '../../../email/deliver.js';
import { acceptInvitationUrl } from '../../../email/links.js';
import { notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { platformListSchema, releaseSchema } from './schemas.js';

/**
 * The support toolkit (P15).
 *
 * Five things a support engineer currently needs somebody with a terminal for:
 * seeing what has been failing, sending an invitation again, unlocking an
 * account, clearing a phone's stuck sync, and knowing which app versions are
 * actually out there.
 *
 * Each of these is a small privilege and each is audited, because "support
 * unlocked an account" and "somebody unlocked an account" are different
 * sentences and only one of them is acceptable to read a year later.
 */

const resentSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
  /** Present only when a web address is configured; never logged. */
  acceptUrl: z.string().nullable(),
  /** Whether the invitation email went out. False when only a link was asked for. */
  emailed: z.boolean(),
  /** Why the email did not go out, when it was asked for and failed. */
  emailProblem: z.string().nullable(),
});

/** Who an invitation from Integr8's own people says it is from. */
export const INTEGR8_INVITER = 'Integr8';

const failureSchema = z.object({
  id: z.uuid(),
  queue: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  failedAt: z.iso.datetime(),
  /** True once it has stopped being retried and is waiting for a person. */
  deadLettered: z.boolean(),
});

export const recentErrorsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/errors',
  operationId: 'listCompanyErrors',
  summary: 'Background work that failed for this company',
  description:
    'Jobs, not HTTP errors: request failures go to Sentry. What Sentry cannot show is the import or upload that quietly gave up, which is what people ring about.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  body: noSchema,
  responses: {
    200: { description: 'The failures, newest first.', schema: platformListSchema(failureSchema) },
  },
  handler: async ({ params, query }, context) => {
    void context;
    const failures = await getPlatformDataSource().insights.recentFailures(
      params.tenantId,
      query.limit,
    );

    return {
      status: 200,
      body: {
        items: failures.map((failure) => ({
          id: failure.id,
          queue: failure.queue,
          attempts: failure.attempts,
          lastError: failure.lastError,
          failedAt: iso(failure.failedAt),
          deadLettered: failure.deadLettered,
        })),
      },
    };
  },
});

export const unlockAccountRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/users/:userId/unlock',
  operationId: 'unlockAccount',
  summary: 'Lift a lockout after too many failed sign-ins',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid(), userId: z.uuid() }),
  query: noSchema,
  body: z.object({ reason: z.string().min(5).max(500) }),
  responses: {
    200: { description: 'Unlocked.', schema: z.object({ unlocked: z.boolean() }) },
    404: { description: 'No such member.' },
  },
  handler: async ({ params, body }, context) => {
    const member = await withTenant(toTenantId(params.tenantId), (tx) =>
      tx.tenantUsers.findByUserId(toUserId(params.userId)),
    );
    if (member === undefined) {
      throw notFound(`No member ${params.userId} in this company`);
    }

    // `platform:<id>` rather than a foreign key: an unlock can come from a
    // tenant admin or from here, and `account_locks` belongs to neither
    // identity space.
    const auth = await getAuthDataSource();
    const unlocked = await auth.loginSecurity.unlock(
      member.email,
      `platform:${context.platform.platformUserId}`,
    );

    await recordPlatformAction(context, {
      action: 'support.account_unlocked',
      tenantId: params.tenantId,
      targetKind: 'user',
      targetId: params.userId,
      reason: body.reason,
    });

    return { status: 200, body: { unlocked } };
  },
});

export const clearSyncRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/sync/reset',
  operationId: 'resetCompanySync',
  summary: 'Unstick this company’s phones',
  description:
    'Forgets the change log up to now, so every device bootstraps again from scratch. Blunt, and it fixes the failure people actually report — a phone stuck behind a log it can no longer follow. Nothing queued on a device is lost: the outbox is untouched and syncs after the bootstrap.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({ reason: z.string().min(5).max(500) }),
  responses: {
    200: {
      description: 'Cleared.',
      schema: z.object({ removed: z.number().int() }),
    },
  },
  handler: async ({ params, body }, context) => {
    // Through the tenant connection: `prune_sync_touches` refuses to prune a
    // company other than the connection's own, which is the guarantee that a
    // wrong id here cannot reach somebody else's data.
    const removed = await withTenant(toTenantId(params.tenantId), (tx) => tx.sync.prune(0));

    await recordPlatformAction(context, {
      action: 'support.sync_reset',
      tenantId: params.tenantId,
      targetKind: 'tenant',
      targetId: params.tenantId,
      reason: body.reason,
      metadata: { removed },
    });

    return { status: 200, body: { removed } };
  },
});

export const releasesRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/releases',
  operationId: 'listReleases',
  summary: 'Which app versions are live in the field',
  description:
    'From what phones report when they sync, which is the only place a client version is written down. Desktop and web send their version on every request and nothing records it, so they do not appear here — that is a gap to fill by recording it, not by guessing.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
  body: noSchema,
  responses: {
    200: { description: 'Versions in use.', schema: platformListSchema(releaseSchema) },
  },
  handler: async ({ query }, context) => {
    void context;
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
    const releases = await getPlatformDataSource().insights.releases(since);

    return {
      status: 200,
      body: {
        items: releases.map((release) => ({
          clientApp: release.clientApp,
          version: release.version,
          devices: release.devices,
          lastSeenAt: iso(release.lastSeenAt),
        })),
      },
    };
  },
});

export const resendInvitationRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/invitations/:invitationId/resend',
  operationId: 'resendInvitation',
  summary: 'Send somebody their invitation, or a fresh link to it',
  description:
    'Withdraws the old invitation and issues a new one to the same address and role, valid for seven days from now, then emails it unless `sendEmail` is false (the link is returned either way, to send by hand). A new token rather than the old one: the old link may be sitting in a mailbox somebody else can read. Works on an expired invitation too, which is how a company set up weeks ago gets its owner in once its forms are ready.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid(), invitationId: z.uuid() }),
  query: noSchema,
  body: z.object({
    /** Email the invitation (default), or only return a fresh link. */
    sendEmail: z.boolean().default(true),
  }),
  responses: {
    200: { description: 'A new invitation.', schema: resentSchema },
    404: { description: 'No such invitation, or it has been accepted already.' },
  },
  handler: async ({ params, body }, context) => {
    const tenantId = toTenantId(params.tenantId);
    const platformUserId = context.platform.platformUserId;

    const reissued = await withTenant(tenantId, async (tx) => {
      const pending = (await tx.invitations.listPending()).find(
        (invitation) => invitation.id === params.invitationId,
      );
      if (pending === undefined) {
        return undefined;
      }

      // The super admin's id in a tenant column. Neither `invited_by_user_id`
      // nor `revoked_by_user_id` has a foreign key, and naming the platform
      // user is the truth: attributing this to one of the company's own people
      // would be a lie in the table they read to work out who did what.
      await tx.invitations.revoke(pending.id, toUserId(platformUserId));

      const secret = mintInvitationToken(tenantId);
      const created = await tx.invitations.create({
        email: pending.email,
        role: pending.role,
        invitedByUserId: toUserId(platformUserId),
        tokenHash: secret.hash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
      });

      return { invitation: created, token: secret.token };
    });

    if (reissued === undefined) {
      throw notFound(`No pending invitation ${params.invitationId} in this company`);
    }

    const delivery = body.sendEmail
      ? await deliverInvitation({
          sender: context.services.email,
          config: context.config,
          logger: context.logger,
          tenantId,
          email: reissued.invitation.email,
          token: reissued.token,
          invitedBy: INTEGR8_INVITER,
          expiresAt: reissued.invitation.expiresAt,
        })
      : { sent: false, problem: null };

    await recordPlatformAction(context, {
      action: 'support.invitation_resent',
      tenantId: params.tenantId,
      targetKind: 'invitation',
      targetId: reissued.invitation.id,
      metadata: {
        email: reissued.invitation.email,
        replaced: params.invitationId,
        emailed: delivery.sent,
      },
    });

    return {
      status: 200,
      body: {
        id: reissued.invitation.id,
        email: reissued.invitation.email,
        expiresAt: iso(reissued.invitation.expiresAt),
        acceptUrl: acceptInvitationUrl(context.config.WEB_APP_URL, reissued.token),
        emailed: delivery.sent,
        emailProblem: delivery.problem,
      },
    };
  },
});

export const resetSecondFactorRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/admins/:platformUserId/second-factor/reset',
  operationId: 'resetSecondFactor',
  summary: 'Let a super admin enrol a new authenticator',
  description:
    'For a colleague who has lost their phone. It removes their second factor and ends every session they have, so the account cannot be signed in to until they enrol again — which is the point: an account with the second factor removed and a live session is an account with one factor.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ platformUserId: z.uuid() }),
  query: noSchema,
  body: z.object({ reason: z.string().min(5).max(500) }),
  responses: {
    200: { description: 'Removed.', schema: z.object({ reset: z.boolean() }) },
    404: { description: 'No such platform account.' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource();
    const account = await platform.platformUsers.findById(params.platformUserId);
    if (account === undefined) {
      throw notFound(`No platform account ${params.platformUserId}`);
    }

    await platform.platformUsers.setTotpSecret(account.id, null);
    await platform.platformSessions.revokeAllFor(account.id, 'account_disabled');

    await recordPlatformAction(context, {
      action: 'support.second_factor_reset',
      targetKind: 'platform_user',
      targetId: account.id,
      reason: body.reason,
      metadata: { email: account.email },
    });

    return { status: 200, body: { reset: true } };
  },
});

/** Matches the tenant-side invitation lifetime: long enough to survive a holiday. */
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const platformSupportRoutes = [
  recentErrorsRoute,
  unlockAccountRoute,
  resendInvitationRoute,
  resetSecondFactorRoute,
  clearSyncRoute,
  releasesRoute,
];
