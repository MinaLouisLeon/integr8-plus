import { NotAMemberError } from '@integr8/auth';
import { toTenantId, type TenantId } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { iso, signInResponseSchema, tokensSchema } from './schemas.js';

/**
 * Signing in, refreshing, switching company, signing out.
 *
 * All public except the last two, which need a token to say who is asking.
 * None is idempotent in the `Idempotency-Key` sense: minting a session twice is
 * not a duplicated effect, it is two sessions, and a client that retried should
 * get a working one rather than a replay of a token it may have lost.
 */

const signInBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
  clientApp: z.enum(['web', 'desktop', 'mobile']).default('web'),
  /** Which company to sign in to. Omitted means the only one, or the first. */
  tenantId: z.uuid().optional(),
  /**
   * The company this app was built for, by short name. An app built for one
   * company only signs its own people in: an account from any other company
   * is refused with 403 `wrong_company`, so one company's app can never show
   * another's data. Takes precedence over `tenantId`.
   */
  companySlug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u)
    .optional(),
  deviceLabel: z.string().max(120).optional(),
});

/**
 * The company an app was built for, or 403 when the slug names none: the app
 * is wrong about the world, and signing somebody into whichever company they
 * happen to belong to would be exactly the leak the slug exists to prevent.
 */
async function lockedCompany(
  slug: string | undefined,
): Promise<{ tenantId: TenantId; name: string } | undefined> {
  if (slug === undefined) {
    return undefined;
  }
  const tenant = await getPlatformDataSource().tenants.findBySlug(slug);
  if (tenant?.deletedAt !== null) {
    throw wrongCompany(slug);
  }
  return { tenantId: toTenantId(tenant.id), name: tenant.name };
}

function wrongCompany(name: string): ApiError {
  return new ApiError(
    403,
    'wrong_company',
    `This app is for ${name}. Your account does not belong to that company.`,
  );
}

/** Runs a sign-in; a membership refusal becomes `wrong_company` when the app named one. */
async function signInLocked<T>(
  company: { tenantId: TenantId; name: string } | undefined,
  run: (tenantId: TenantId | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await run(company?.tenantId);
  } catch (error) {
    if (company !== undefined && error instanceof NotAMemberError) {
      throw wrongCompany(company.name);
    }
    throw error;
  }
}

export const signInRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/sign-in',
  operationId: 'signIn',
  summary: 'Sign in with an email address and password',
  description:
    'Returns a token pair for one company, plus every company this person belongs to. A wrong password, an unknown address and an identity with no company are all the same failure, deliberately: distinguishing them would turn this endpoint into a way of testing which addresses are customers.',
  tags: ['authentication'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: signInBody,
  responses: {
    200: { description: 'Signed in.', schema: signInResponseSchema },
    401: { description: 'The credentials were not accepted.' },
    403: {
      description:
        'The app was built for one company and this account is not in it (`wrong_company`).',
    },
    423: { description: 'Too many failed attempts; the address is locked.' },
  },
  handler: async ({ body }, context) => {
    const company = await lockedCompany(body.companySlug);
    const chosen =
      company?.tenantId ?? (body.tenantId === undefined ? undefined : toTenantId(body.tenantId));
    const result = await signInLocked(company, () =>
      context.services.signIn.signInWithPassword({
        email: body.email,
        password: body.password,
        clientApp: body.clientApp,
        ...(chosen === undefined ? {} : { tenantId: chosen }),
        deviceLabel: body.deviceLabel ?? null,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      }),
    );

    return { status: 200, body: toSignInResponse(result) };
  },
});

export const requestMagicLinkRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/magic-link',
  operationId: 'requestMagicLink',
  summary: 'Send a one-time sign-in link',
  description:
    'Always succeeds, whether or not the address is known. An endpoint that answered differently for a known address would be a free customer-list oracle.',
  tags: ['authentication'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.string().min(3).max(320),
    redirectTo: z.url(),
  }),
  responses: { 202: { description: 'The request was accepted.' } },
  handler: async ({ body }, context) => {
    await context.services.signIn.sendMagicLink(body.email, body.redirectTo);
    // 202, not 200: nothing is asserted about whether an email was sent.
    return { status: 202, body: {} };
  },
});

export const completeMagicLinkRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/magic-link/complete',
  operationId: 'completeMagicLink',
  summary: 'Exchange a magic-link token for a session',
  tags: ['authentication'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.string().min(3).max(320),
    token: z.string().min(1).max(512),
    clientApp: z.enum(['web', 'desktop', 'mobile']).default('web'),
    tenantId: z.uuid().optional(),
    companySlug: signInBody.shape.companySlug,
    deviceLabel: z.string().max(120).optional(),
  }),
  responses: {
    200: { description: 'Signed in.', schema: signInResponseSchema },
    401: { description: 'The link is invalid or has expired.' },
    403: {
      description:
        'The app was built for one company and this account is not in it (`wrong_company`).',
    },
  },
  handler: async ({ body }, context) => {
    const company = await lockedCompany(body.companySlug);
    const chosen =
      company?.tenantId ?? (body.tenantId === undefined ? undefined : toTenantId(body.tenantId));
    const result = await signInLocked(company, () =>
      context.services.signIn.completeMagicLink({
        email: body.email,
        token: body.token,
        clientApp: body.clientApp,
        ...(chosen === undefined ? {} : { tenantId: chosen }),
        deviceLabel: body.deviceLabel ?? null,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      }),
    );

    return { status: 200, body: toSignInResponse(result) };
  },
});

export const refreshRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/refresh',
  operationId: 'refreshSession',
  summary: 'Exchange a refresh token for a new pair',
  description:
    'Single-use. The token returned replaces the one sent, and presenting a spent token is treated as theft: the session is revoked and both the thief and the legitimate holder are signed out.',
  tags: ['authentication'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({ refreshToken: z.string().min(1).max(512) }),
  responses: {
    200: { description: 'A new token pair.', schema: tokensSchema },
    401: { description: 'The refresh token is unknown, expired, spent or its session is gone.' },
  },
  handler: async ({ body }, context) => {
    const issued = await context.services.sessions.refresh(body.refreshToken);
    return { status: 200, body: toTokens(issued) };
  },
});

export const switchTenantRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/switch-tenant',
  operationId: 'switchTenant',
  summary: 'Move to another of your companies',
  description:
    'Membership is checked afresh: holding a valid token for one company says nothing about another. The current session is revoked, so a device holds one session at a time. An impersonation session cannot switch: its grant covers one company only.',
  tags: ['authentication'],
  security: 'authenticated',
  // Leaving a company that has stopped paying for one that has not is not a
  // write to the first company; refusing it would trap a person in the wrong
  // one.
  allowedWhenReadOnly: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    tenantId: z.uuid(),
    clientApp: z.enum(['web', 'desktop', 'mobile']).default('web'),
    deviceLabel: z.string().max(120).optional(),
  }),
  responses: {
    200: { description: 'Switched.', schema: signInResponseSchema },
    403: {
      description: 'Not a member of that company, or impersonating (`auth.impersonation_denied`).',
    },
  },
  handler: async ({ body }, context) => {
    const result = await context.services.signIn.switchTenant(
      context.principal,
      toTenantId(body.tenantId),
      {
        clientApp: body.clientApp,
        deviceLabel: body.deviceLabel ?? null,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      },
    );

    return { status: 200, body: toSignInResponse(result) };
  },
});

export const signOutRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/sign-out',
  operationId: 'signOut',
  summary: 'End this session, or every session',
  tags: ['authentication'],
  // Signing out has to work whatever the company owes (P17). Trapping somebody
  // in a session they are trying to leave would be absurd.
  allowedWhenReadOnly: true,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: z.object({
    everywhere: z
      .boolean()
      .default(false)
      .describe('End every session for this person in this company, not only this one.'),
  }),
  responses: { 200: { description: 'Signed out.', schema: z.object({ revoked: z.number() }) } },
  handler: async ({ body }, context) => {
    // A phone signed out of stops hearing about jobs at once (P14).
    await withTenant(context.principal.tenantId, (tx) =>
      tx.pushDevices.disableSignedOut(
        body.everywhere
          ? { userId: context.principal.userId }
          : { sessionId: context.principal.sessionId },
      ),
    );

    if (body.everywhere) {
      const revoked = await context.services.sessions.revokeAllForUser(
        context.principal.tenantId,
        context.principal.userId,
        'signed_out_everywhere',
      );
      return { status: 200, body: { revoked } };
    }

    const revoked = await context.services.sessions.revoke(
      context.principal.tenantId,
      context.principal.sessionId,
      'signed_out',
    );

    return { status: 200, body: { revoked: revoked ? 1 : 0 } };
  },
});

export const authRoutes = [
  signInRoute,
  requestMagicLinkRoute,
  completeMagicLinkRoute,
  refreshRoute,
  switchTenantRoute,
  signOutRoute,
];

// ---------------------------------------------------------------------------

interface IssuedLike {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  session: { id: string };
}

function toTokens(issued: IssuedLike) {
  return {
    accessToken: issued.accessToken,
    accessTokenExpiresAt: iso(issued.accessTokenExpiresAt),
    refreshToken: issued.refreshToken,
    refreshTokenExpiresAt: iso(issued.refreshTokenExpiresAt),
    sessionId: issued.session.id,
  };
}

function toSignInResponse(result: {
  tokens: IssuedLike;
  tenantId: string;
  userId: string;
  memberships: { tenantId: string; role: string; status: string }[];
}) {
  return {
    tokens: toTokens(result.tokens),
    tenantId: result.tenantId,
    userId: result.userId,
    memberships: result.memberships.map((membership) => ({
      tenantId: membership.tenantId,
      role: membership.role,
      status: membership.status,
    })),
  };
}
