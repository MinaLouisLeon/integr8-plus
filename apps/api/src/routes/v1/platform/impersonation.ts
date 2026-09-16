import { toPlatformUserId, toTenantId, toUserId } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { impersonationSchema, platformListSchema } from './schemas.js';

/**
 * Acting as a customer's user, from the dashboard (P15).
 *
 * The decision here was how much access impersonation gives, and the answer is
 * all of it: a support engineer reproducing a problem needs to do what the
 * person who reported it did, and a read-only mode would mean reproducing half
 * of every report. What makes that acceptable is the other half of the same
 * decision — every action is attributed to the super admin behind it, in this
 * company's audit log and in the platform's, and the token says so in a claim
 * the three apps use to paint a banner nobody can miss.
 *
 * The service underneath (P03) writes the audit entry *before* the grant
 * exists, and the grant carries a non-null foreign key to it. There is no
 * ordering of those writes that produces a session with no entry.
 */

const grantSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  platformUserId: z.uuid(),
  targetUserId: z.uuid(),
  reason: z.string(),
  startedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  endedReason: z.string().nullable(),
  /** How long it actually lasted, in seconds. Null while it is still running. */
  durationSeconds: z.number().int().nullable(),
});

export const startImpersonationRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/impersonate',
  operationId: 'startImpersonation',
  summary: 'Act as a user in this company',
  description:
    'Needs a reason of at least ten characters, which a check constraint enforces rather than this schema alone. The grant lapses on its own after the configured window; ending it early is one call.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({
    targetUserId: z.uuid(),
    reason: z.string().min(10).max(500),
  }),
  responses: {
    201: { description: 'Impersonating.', schema: impersonationSchema },
    403: { description: 'This platform account may not impersonate here.' },
    404: { description: 'No such company or user.' },
  },
  handler: async ({ params, body }, context) => {
    const tenant = await getPlatformDataSource().tenants.findById(params.tenantId);
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    const started = await context.services.impersonation.start({
      platformUserId: toPlatformUserId(context.platform.platformUserId),
      tenantId: toTenantId(params.tenantId),
      targetUserId: toUserId(body.targetUserId),
      reason: body.reason,
      clientApp: context.clientApp,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await recordPlatformAction(context, {
      action: 'impersonation.started',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'user',
      targetId: body.targetUserId,
      reason: body.reason,
      metadata: { grantId: started.grantId, expiresAt: iso(started.expiresAt) },
    });

    return {
      status: 201,
      body: {
        grantId: started.grantId,
        tenantId: tenant.id,
        targetUserId: body.targetUserId,
        reason: body.reason,
        expiresAt: iso(started.expiresAt),
        tokens: {
          accessToken: started.tokens.accessToken,
          accessTokenExpiresAt: iso(started.tokens.accessTokenExpiresAt),
          refreshToken: started.tokens.refreshToken,
          refreshTokenExpiresAt: iso(started.tokens.refreshTokenExpiresAt),
          sessionId: started.tokens.session.id,
        },
      },
    };
  },
});

export const endImpersonationRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/impersonate/:grantId/end',
  operationId: 'endImpersonation',
  summary: 'Stop acting as that user',
  description:
    'The one-click exit behind the banner. Ends the grant and the session minted under it, so the token stops working on the next request rather than when it expires.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid(), grantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Ended.', schema: z.object({ ended: z.boolean() }) },
  },
  handler: async ({ params }, context) => {
    const ended = await context.services.impersonation.end(
      params.grantId,
      toTenantId(params.tenantId),
      'ended_by_admin',
    );

    if (ended) {
      await recordPlatformAction(context, {
        action: 'impersonation.ended',
        tenantId: params.tenantId,
        targetKind: 'impersonation_grant',
        targetId: params.grantId,
      });
    }

    return { status: 200, body: { ended } };
  },
});

export const listImpersonationRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/impersonations',
  operationId: 'listImpersonations',
  summary: 'Every time somebody acted as a user in this company',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The grants, newest first.', schema: platformListSchema(grantSchema) },
  },
  handler: async ({ params }, context) => {
    const grants = await context.services.impersonation.listForTenant(toTenantId(params.tenantId));

    return {
      status: 200,
      body: {
        items: grants.map((grant) => ({
          id: grant.id,
          tenantId: params.tenantId,
          platformUserId: grant.platformUserId,
          targetUserId: grant.targetUserId,
          reason: grant.reason,
          startedAt: iso(grant.createdAt),
          expiresAt: iso(grant.expiresAt),
          endedAt: isoOrNull(grant.endedAt),
          endedReason: grant.endedReason,
          durationSeconds:
            grant.endedAt === null
              ? null
              : Math.round((grant.endedAt.getTime() - grant.createdAt.getTime()) / 1000),
        })),
      },
    };
  },
});

export const platformImpersonationRoutes = [
  startImpersonationRoute,
  endImpersonationRoute,
  listImpersonationRoute,
];
