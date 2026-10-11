import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { unauthorised } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso } from '../schemas.js';
import { platformMeSchema, platformSignInResponseSchema, platformTokensSchema } from './schemas.js';
import { recordPlatformAction } from './audit.js';

/**
 * Signing a super admin in (P15).
 *
 * Separate from `/v1/auth/*` all the way down: a different table, a different
 * token type, a different session, a different lifetime. Nothing a customer
 * signs in with reaches this, and nothing minted here carries a company.
 *
 * Every one of these is public in the route sense — they are how you get a
 * platform token in the first place — and each writes to the platform audit
 * log, because "who signed in to the dashboard, from where, and when" is the
 * first question anybody asks after an incident.
 */

export const platformSignInRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/auth/sign-in',
  operationId: 'platformSignIn',
  summary: 'Sign in to the platform dashboard',
  description:
    'Password and a six-digit code, together. A wrong password, a wrong code and an unknown address are the same failure on purpose; a locked account is the one case that says more, because waiting is the fix and the person needs to know that.',
  tags: ['platform'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.string().min(3).max(320),
    password: z.string().min(1).max(200),
    code: z.string().min(6).max(10),
  }),
  responses: {
    200: { description: 'Signed in.', schema: platformSignInResponseSchema },
    401: { description: 'The credentials were not accepted.' },
    423: { description: 'Too many failed attempts; the account is locked.' },
  },
  handler: async ({ body }, context) => {
    const signedIn = await context.services.platform.signIn({
      email: body.email,
      password: body.password,
      code: body.code,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await recordPlatformAction(context, {
      platformUserId: signedIn.platformUser.id,
      actorLabel: signedIn.platformUser.email,
      action: 'platform.signed_in',
      targetKind: 'platform_session',
      targetId: signedIn.sessionId,
    });

    return {
      status: 200,
      body: {
        tokens: toTokens(signedIn),
        platformUser: {
          id: signedIn.platformUser.id,
          email: signedIn.platformUser.email,
          displayName: signedIn.platformUser.displayName,
        },
      },
    };
  },
});

export const platformRefreshRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/auth/refresh',
  operationId: 'platformRefresh',
  summary: 'Exchange a platform refresh token for a new pair',
  description:
    'Single-use. Presenting one that has already been spent ends the session, because the only two explanations are a client racing itself and a stolen token, and one of them must not be allowed to continue.',
  tags: ['platform'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({ refreshToken: z.string().min(1).max(512) }),
  responses: {
    200: { description: 'A new token pair.', schema: platformTokensSchema },
    401: { description: 'The refresh token is unknown, spent or expired.' },
  },
  handler: async ({ body }, context) => {
    const refreshed = await context.services.platform.refresh(body.refreshToken);
    return { status: 200, body: toTokens(refreshed) };
  },
});

export const platformSignOutRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/auth/sign-out',
  operationId: 'platformSignOut',
  summary: 'End this platform session',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: z.object({
    /** Ends every browser this account is signed in on, not only this one. */
    everywhere: z.boolean().default(false),
  }),
  responses: { 204: { description: 'Signed out.' } },
  handler: async ({ body }, context) => {
    await recordPlatformAction(context, {
      action: body.everywhere ? 'platform.signed_out_everywhere' : 'platform.signed_out',
      targetKind: 'platform_session',
      targetId: context.platform.sessionId,
    });
    await context.services.platform.signOut(context.platform.sessionId, body.everywhere);
    return { status: 204, body: {} };
  },
});

export const platformMeRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/me',
  operationId: 'platformMe',
  summary: 'Who this platform session belongs to',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The signed-in super admin.', schema: platformMeSchema },
  },
  handler: async (_input, context) => {
    const account = await getPlatformDataSource().platformUsers.findById(
      context.platform.platformUserId,
    );
    if (account === undefined) {
      throw unauthorised();
    }

    return {
      status: 200,
      body: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        canManageStaff: account.canManageStaff,
      },
    };
  },
});

function toTokens(result: {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}): z.infer<typeof platformTokensSchema> {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: iso(result.accessTokenExpiresAt),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: iso(result.refreshTokenExpiresAt),
    sessionId: result.sessionId,
  };
}

export const platformAuthRoutes = [
  platformSignInRoute,
  platformRefreshRoute,
  platformSignOutRoute,
  platformMeRoute,
];
