import { InvalidCredentialsError, NotAMemberError } from '@integr8/auth';
import { toTenantId, type TenantId } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { deliverPasswordChanged, deliverSignInCode } from '../../email/deliver.js';
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
    'Returns a token pair for one company, plus every company this person belongs to. For `clientApp: mobile` the pair also carries the offline grant that lets the phone open with no network for seven days (`offlineGrant`, `offlineGrantExpiresAt`). A wrong password, an unknown address and an identity with no company are all the same failure, deliberately: distinguishing them would turn this endpoint into a way of testing which addresses are customers.',
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

/**
 * How long a sign-in code lasts, for the email to say so. Auth decides it
 * (`GOTRUE_MAILER_OTP_EXP` in `deploy/compose.yml`, 900 seconds); keep the two
 * together.
 */
const SIGN_IN_CODE_MINUTES = 15;

/** The two languages an email can be in. A screen sends the one it is showing. */
export const emailLocaleSchema = z
  .enum(['en', 'ar'])
  .optional()
  .describe('The language for the email: the one the screen is showing. English when left out.');

export const requestMagicLinkRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/magic-link',
  operationId: 'requestMagicLink',
  summary: 'Email a 6-digit sign-in code',
  description:
    'Emails a one-time 6-digit code that signs in through `/v1/auth/magic-link/complete`. Always answers 202 the same way, whether or not the address has an account: an endpoint that answered differently for a known address would be a free customer-list oracle. One code per address per minute and five per hour, counted the same for unknown addresses (429 `auth.rate_limited`). The path keeps its old name so nothing inside `/v1` changes; `redirectTo` is accepted and ignored, because the email carries a code and no link.',
  tags: ['authentication'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.string().min(3).max(320),
    redirectTo: z.url().optional().describe('Ignored. Kept so older clients still validate.'),
    locale: emailLocaleSchema,
  }),
  responses: {
    202: { description: 'The request was accepted.' },
    429: { description: 'Too many codes asked for this address or from this network.' },
  },
  handler: async ({ body }, context) => {
    const request = {
      email: body.email,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    };
    await context.services.signIn.checkSignInCodeLimits(request);

    // The rest runs after the answer: looking the address up, asking Auth for a
    // code and emailing it all take time an unknown address would not, and a
    // stranger could time the difference. A failure is logged, never answered.
    const { signIn, email } = context.services;
    const { logger } = context;
    void signIn
      .issueSignInCode(request)
      .then(async (issued) => {
        if (issued !== undefined) {
          await deliverSignInCode({
            sender: email,
            logger,
            email: issued.email,
            code: issued.code,
            minutes: SIGN_IN_CODE_MINUTES,
            locale: body.locale ?? 'en',
          });
        }
      })
      .catch((error: unknown) => {
        logger.error('Sign-in code not sent', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    // 202, not 200: nothing is asserted about whether an email was sent.
    return { status: 202, body: {} };
  },
});

export const completeMagicLinkRoute = defineRoute({
  method: 'post',
  path: '/v1/auth/magic-link/complete',
  operationId: 'completeMagicLink',
  summary: 'Sign in with an emailed 6-digit code',
  description:
    '`token` is the 6-digit code from the email. A wrong code counts towards the account lockout exactly as a wrong password does. The session that results lets Change password go without the current password for fifteen minutes. For `clientApp: mobile` the pair carries the offline grant, as with a password.',
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
    401: { description: 'The code is wrong, spent or has expired.' },
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
      context.services.signIn.completeSignInCode({
        email: body.email,
        code: body.token,
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
    'Single-use. The token returned replaces the one sent, and presenting a spent token is treated as theft: the session is revoked and both the thief and the legitimate holder are signed out. A phone’s session also gets a new offline grant, replacing the last, so it runs for seven days from the phone’s last contact rather than from signing in.',
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

export const changePasswordRoute = defineRoute({
  method: 'post',
  path: '/v1/me/password',
  operationId: 'changePassword',
  summary: 'Change your password',
  description:
    'Needs `currentPassword`, unless this session began with an emailed sign-in code in the last fifteen minutes — the way back in for somebody who has forgotten it. Without either the answer is 403 `auth.current_password_required`; a wrong current password counts towards the account lockout. Every other session this person has, in every company, is signed out, offline access on phones included; this one stays. The address is emailed to say the password was changed.',
  tags: ['authentication'],
  security: 'authenticated',
  // Your own password is not the company's data, and a company that owes money
  // must not keep somebody on a password they want rid of.
  allowedWhenReadOnly: true,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    currentPassword: z.string().min(1).max(200).optional(),
    newPassword: z.string().min(1).max(200),
    locale: emailLocaleSchema,
  }),
  responses: {
    200: {
      description: 'Changed.',
      schema: z.object({
        signedOutElsewhere: z
          .number()
          .int()
          .describe('Other sessions signed out, across every company.'),
        emailed: z.boolean().describe('Whether the "password changed" email went.'),
      }),
    },
    403: {
      description:
        'The current password is wrong (`auth.current_password_wrong`); none was given and there was no recent code sign-in (`auth.current_password_required`); or impersonating (`auth.impersonation_denied`).',
    },
    422: { description: 'The new password is too weak (`auth.weak_password`).' },
    423: { description: 'Too many failed attempts; the address is locked.' },
  },
  handler: async ({ body }, context) => {
    let result;
    try {
      result = await context.services.passwords.changePassword({
        principal: context.principal,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
    } catch (error) {
      // Not 401: every client reads a 401 as "your token has expired", refreshes
      // and sends the request again, which would count a mistyped password
      // twice towards the lockout and say nothing useful to the person.
      if (error instanceof InvalidCredentialsError) {
        throw new ApiError(
          403,
          'auth.current_password_wrong',
          'The current password is not right.',
        );
      }
      throw error;
    }

    // After the change, and never able to undo it: a failed send is logged by
    // `deliver` and reported back, nothing more.
    const tenantId = context.principal.tenantId;
    const locale =
      body.locale ?? (await withTenant(tenantId, async (tx) => (await tx.settings.get()).locale));
    const delivery = await deliverPasswordChanged({
      sender: context.services.email,
      logger: context.logger,
      email: result.email,
      changedAt: result.changedAt,
      locale: locale === 'ar' ? 'ar' : 'en',
      tenantId,
    });

    return {
      status: 200,
      body: { signedOutElsewhere: result.revoked, emailed: delivery.sent },
    };
  },
});

export const authRoutes = [
  signInRoute,
  requestMagicLinkRoute,
  completeMagicLinkRoute,
  refreshRoute,
  switchTenantRoute,
  signOutRoute,
  changePasswordRoute,
];

// ---------------------------------------------------------------------------

interface IssuedLike {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  session: { id: string };
  offlineGrant?: { token: string; expiresAt: Date } | undefined;
}

function toTokens(issued: IssuedLike) {
  return {
    accessToken: issued.accessToken,
    accessTokenExpiresAt: iso(issued.accessTokenExpiresAt),
    refreshToken: issued.refreshToken,
    refreshTokenExpiresAt: iso(issued.refreshTokenExpiresAt),
    sessionId: issued.session.id,
    // Only a phone's session has one (P03): left out, not null, so an older
    // client's parser sees exactly the shape it always did.
    ...(issued.offlineGrant === undefined
      ? {}
      : {
          offlineGrant: issued.offlineGrant.token,
          offlineGrantExpiresAt: iso(issued.offlineGrant.expiresAt),
        }),
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
