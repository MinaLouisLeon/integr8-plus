import { z } from 'zod';
import { platformUserIdSchema, tenantIdSchema, userIdSchema } from './ids.js';
import { roleSchema } from './roles.js';

/**
 * The shape of the tokens this system issues.
 *
 * Declared in `@integr8/core` rather than in `@integr8/auth` because all four
 * clients need to *read* a token — to know which company they are looking at,
 * to hide a button a viewer cannot use, to notice an offline grant is about to
 * expire. None of them may *verify* one: that needs the signing key and lives
 * server-side. Types here, crypto there.
 *
 * Three token types, one signing key, one algorithm:
 *
 * - **access** — 15 minutes, presented on every API call.
 * - **offline** — days, verified by the mobile app itself with an embedded
 *   public key so the app opens in a basement with no signal.
 * - **platform** — minutes, and the only token with no company in it at all: a
 *   super admin signed in to the dashboard (P15). Widening the access token to
 *   allow a null tenant was the alternative, and it would have meant every
 *   handler in the system asking whether `tid` was really there.
 *
 * Refresh tokens are deliberately absent: they are opaque random strings, not
 * JWTs, stored only as a hash. A refresh token that could be read would tell an
 * attacker which company it unlocks before they had spent it.
 */

export const TOKEN_TYPES = ['access', 'offline', 'platform'] as const;
export const tokenTypeSchema = z.enum(TOKEN_TYPES);
export type TokenType = z.infer<typeof tokenTypeSchema>;

/**
 * Present only while a super admin is acting as somebody else.
 *
 * Its presence is what makes impersonation visible everywhere downstream: an
 * audit entry, a log line and a UI banner can all key on it rather than on a
 * flag someone remembered to pass along.
 */
export const impersonationClaimSchema = z.object({
  /** The `platform_users.id` doing the impersonating. */
  pid: platformUserIdSchema,
  /** The `impersonation_grants.id` this token was minted under. */
  gid: z.uuid(),
});

export type ImpersonationClaim = z.infer<typeof impersonationClaimSchema>;

const registeredClaims = {
  iss: z.string().min(1),
  aud: z.string().min(1),
  /** The auth identity. Stable across companies: one person, one `sub`. */
  sub: userIdSchema,
  /** Unique per token, so a single token can be denied without killing a session. */
  jti: z.uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
};

export const accessTokenClaimsSchema = z.object({
  ...registeredClaims,
  typ: z.literal('access'),
  /** The company this token acts for. Copied into the `app.tenant_id` GUC by P02's data layer. */
  tid: tenantIdSchema,
  role: roleSchema,
  /** The `sessions.id` this token was minted from; revoking it invalidates the token. */
  sid: z.uuid(),
  imp: impersonationClaimSchema.optional(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const offlineGrantClaimsSchema = z.object({
  ...registeredClaims,
  typ: z.literal('offline'),
  tid: tenantIdSchema,
  role: roleSchema,
  sid: z.uuid(),
  /** The `offline_grants.id`, so a lost phone's grant can be revoked by itself. */
  gid: z.uuid(),
});

export type OfflineGrantClaims = z.infer<typeof offlineGrantClaimsSchema>;

/**
 * A super admin signed in to the dashboard (P15).
 *
 * No `tid`, no `role`: this token proves who you are on the platform and
 * nothing about any company. Reaching a company's data from here means minting
 * an impersonation token, which writes an audit entry first.
 */
export const platformTokenClaimsSchema = z.object({
  ...registeredClaims,
  sub: platformUserIdSchema,
  typ: z.literal('platform'),
  /** The `platform_sessions.id` this token was minted from. */
  sid: z.uuid(),
});

export type PlatformTokenClaims = z.infer<typeof platformTokenClaimsSchema>;

/**
 * Who a request is from, after a token has been verified.
 *
 * This is what handlers receive. It is a flattened, named version of the
 * claims, because `principal.tenantId` reads better at a call site than
 * `claims.tid`, and because the field names being different from the wire
 * format makes it obvious when unverified claims have leaked into business
 * logic by mistake.
 */
export interface Principal {
  userId: z.infer<typeof userIdSchema>;
  tenantId: z.infer<typeof tenantIdSchema>;
  role: z.infer<typeof roleSchema>;
  sessionId: string;
  tokenId: string;
  expiresAt: Date;
  /** Set only when a super admin is acting as this user. */
  impersonatedBy?: ImpersonationClaim;
}

/** Builds a {@link Principal} from claims that have already been verified. */
export function toPrincipal(claims: AccessTokenClaims): Principal {
  return {
    userId: claims.sub,
    tenantId: claims.tid,
    role: claims.role,
    sessionId: claims.sid,
    tokenId: claims.jti,
    expiresAt: new Date(claims.exp * 1000),
    ...(claims.imp === undefined ? {} : { impersonatedBy: claims.imp }),
  };
}

/**
 * Who a platform request is from: a super admin, with no company attached.
 *
 * A separate type from {@link Principal} on purpose. Nothing that takes a
 * `Principal` can be handed one of these by mistake, so a tenant handler cannot
 * be reached by a platform token however the routing is wired.
 */
export interface PlatformPrincipal {
  platformUserId: z.infer<typeof platformUserIdSchema>;
  sessionId: string;
  tokenId: string;
  expiresAt: Date;
}

export function toPlatformPrincipal(claims: PlatformTokenClaims): PlatformPrincipal {
  return {
    platformUserId: claims.sub,
    sessionId: claims.sid,
    tokenId: claims.jti,
    expiresAt: new Date(claims.exp * 1000),
  };
}

/** True when this request is a super admin acting as somebody else. */
export function isImpersonating(principal: Principal): boolean {
  return principal.impersonatedBy !== undefined;
}
