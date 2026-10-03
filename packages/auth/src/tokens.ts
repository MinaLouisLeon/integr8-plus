import {
  accessTokenClaimsSchema,
  type AccessTokenClaims,
  type ImpersonationClaim,
  offlineGrantClaimsSchema,
  type OfflineGrantClaims,
  type PlatformPrincipal,
  platformTokenClaimsSchema,
  type PlatformTokenClaims,
  type PlatformUserId,
  type Principal,
  toPlatformPrincipal,
  type Role,
  type TenantId,
  toPrincipal,
  type UserId,
} from '@integr8/core';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AuthConfig } from './config.js';
import { InvalidTokenError } from './errors.js';
import { ALGORITHM, type SigningKey, type VerificationKeySet } from './keys.js';

/**
 * Minting and verifying the two signed token types.
 *
 * Verification is strict about four things, and each of them is a real attack
 * rather than a formality:
 *
 * - **Algorithm.** Pinned to EdDSA. Accepting whatever the header claims is how
 *   `alg: none` and the RS256-to-HS256 confusion attack work.
 * - **Issuer and audience.** A token minted by staging must not open
 *   production.
 * - **Type.** An offline grant lasts a week; an access token lasts fifteen
 *   minutes. Presenting the first where the second is expected must fail, or
 *   the short lifetime is decorative.
 * - **Shape.** Claims are parsed with the same zod schema the clients use, so a
 *   token that verifies cryptographically but carries a role the system does
 *   not define is still rejected.
 */

export interface TokenSigner {
  signingKey: SigningKey;
  verificationKeys: VerificationKeySet;
  config: AuthConfig;
  /** Injectable clock; production does not pass one. */
  now?: () => Date;
}

export interface MintAccessTokenInput {
  userId: UserId;
  tenantId: TenantId;
  role: Role;
  sessionId: string;
  impersonation?: ImpersonationClaim | undefined;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
  tokenId: string;
}

export interface MintOfflineGrantInput {
  userId: UserId;
  tenantId: TenantId;
  role: Role;
  sessionId: string;
  grantId: string;
  /** Overrides the configured window, for a customer with a stricter policy. */
  ttlSeconds?: number;
}

export interface MintPlatformTokenInput {
  platformUserId: PlatformUserId;
  sessionId: string;
}

export class TokenService {
  readonly #signer: TokenSigner;

  constructor(signer: TokenSigner) {
    this.#signer = signer;
  }

  get #now(): Date {
    return this.#signer.now?.() ?? new Date();
  }

  async mintAccessToken(input: MintAccessTokenInput): Promise<MintedToken> {
    const { config } = this.#signer;
    const issuedAt = this.#now;
    const expiresAt = new Date(issuedAt.getTime() + config.AUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    const tokenId = randomUUID();

    const claims: AccessTokenClaims = accessTokenClaimsSchema.parse({
      iss: config.AUTH_ISSUER,
      aud: config.AUTH_AUDIENCE,
      sub: input.userId,
      jti: tokenId,
      iat: toSeconds(issuedAt),
      exp: toSeconds(expiresAt),
      typ: 'access',
      tid: input.tenantId,
      role: input.role,
      sid: input.sessionId,
      ...(input.impersonation === undefined ? {} : { imp: input.impersonation }),
    });

    return { token: await this.#sign(claims), expiresAt, tokenId };
  }

  async mintOfflineGrant(input: MintOfflineGrantInput): Promise<MintedToken> {
    const { config } = this.#signer;
    const issuedAt = this.#now;
    const ttl = input.ttlSeconds ?? config.AUTH_OFFLINE_GRANT_TTL_SECONDS;
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
    const tokenId = randomUUID();

    const claims: OfflineGrantClaims = offlineGrantClaimsSchema.parse({
      iss: config.AUTH_ISSUER,
      aud: config.AUTH_AUDIENCE,
      sub: input.userId,
      jti: tokenId,
      iat: toSeconds(issuedAt),
      exp: toSeconds(expiresAt),
      typ: 'offline',
      tid: input.tenantId,
      role: input.role,
      sid: input.sessionId,
      gid: input.grantId,
    });

    return { token: await this.#sign(claims), expiresAt, tokenId };
  }

  /**
   * A super admin signed in to the dashboard (P15).
   *
   * Carries no company and no role, so there is nothing in it for a tenant
   * handler to read even if one were somehow reached: `verifyAccessToken`
   * rejects it on `typ` before the claims are looked at, and `toPrincipal`
   * could not produce a `tid` from it if it did not.
   */
  async mintPlatformToken(input: MintPlatformTokenInput): Promise<MintedToken> {
    const { config } = this.#signer;
    const issuedAt = this.#now;
    const expiresAt = new Date(
      issuedAt.getTime() + config.PLATFORM_ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
    const tokenId = randomUUID();

    const claims: PlatformTokenClaims = platformTokenClaimsSchema.parse({
      iss: config.AUTH_ISSUER,
      aud: config.AUTH_AUDIENCE,
      sub: input.platformUserId,
      jti: tokenId,
      iat: toSeconds(issuedAt),
      exp: toSeconds(expiresAt),
      typ: 'platform',
      sid: input.sessionId,
    });

    return { token: await this.#sign(claims), expiresAt, tokenId };
  }

  /**
   * Verifies a platform token.
   *
   * Says the token is genuine and unexpired, nothing more. Whether the session
   * behind it is still live is a database question, and
   * `PlatformSessionService.authenticate` is the one that asks it.
   */
  async verifyPlatformToken(token: string): Promise<PlatformPrincipal> {
    return toPlatformPrincipal(await this.#verify(token, platformTokenClaimsSchema, 'platform'));
  }

  /** Verifies an access token and returns who it says the caller is. */
  async verifyAccessToken(token: string): Promise<Principal> {
    return toPrincipal(await this.#verify(token, accessTokenClaimsSchema, 'access'));
  }

  /**
   * Verifies an offline grant.
   *
   * The same check the mobile app runs against its embedded public key. It is
   * here as well so the server can validate a grant presented back to it, and
   * so the two implementations are testable against one another.
   *
   * Verifying signature and expiry says the grant was genuine when issued. It
   * says nothing about whether it has since been revoked — that needs the
   * database, and a device with no network has neither. See
   * docs/auth/offline-access.md.
   */
  async verifyOfflineGrant(token: string): Promise<OfflineGrantClaims> {
    return this.#verify(token, offlineGrantClaimsSchema, 'offline');
  }

  /** The public keys, for a JWKS endpoint and for embedding in the mobile app. */
  publicJwks(): ReturnType<VerificationKeySet['publicJwks']> {
    return this.#signer.verificationKeys.publicJwks();
  }

  async #sign(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, kid: this.#signer.signingKey.kid, typ: 'JWT' })
      .sign(this.#signer.signingKey.key);
  }

  async #verify<T>(
    token: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
    expectedType: string,
  ): Promise<T> {
    if (token === '') {
      throw new InvalidTokenError();
    }

    // The `kid` selects a key from the published set. It never selects an
    // algorithm — that is pinned below — so a forged header can at worst name a
    // key that does not exist.
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new InvalidTokenError();
    }

    if (kid === undefined) {
      throw new InvalidTokenError('Token has no key id');
    }

    const key = await this.#signer.verificationKeys.find(kid);
    if (key === undefined) {
      throw new InvalidTokenError(
        `Token names key "${kid}", which this deployment does not accept`,
      );
    }

    const { config } = this.#signer;
    let payload: unknown;
    try {
      const verified = await jwtVerify(token, key, {
        algorithms: [ALGORITHM],
        issuer: config.AUTH_ISSUER,
        audience: config.AUTH_AUDIENCE,
        currentDate: this.#now,
      });
      payload = verified.payload;
    } catch {
      throw new InvalidTokenError();
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success || parsed.data === undefined) {
      throw new InvalidTokenError(
        `Token verified but its claims are not a valid ${expectedType} token`,
      );
    }

    return parsed.data;
  }
}

function toSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
