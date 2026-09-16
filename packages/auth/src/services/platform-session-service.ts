import { type PlatformPrincipal, type PlatformUserId, toPlatformUserId } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import { randomBytes } from 'node:crypto';
import type { AuthConfig } from '../config.js';
import {
  AccountLockedError,
  InvalidCredentialsError,
  InvalidTokenError,
  RefreshTokenReuseError,
  SessionRevokedError,
} from '../errors.js';
import { hashPassword, needsRehash, verifyPassword } from '../passwords.js';
import { hashSecret, openSecret, sealSecret, secretKeyFrom } from '../secrets.js';
import type { TokenService } from '../tokens.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../totp.js';

/**
 * Signing a super admin in to the dashboard (P15).
 *
 * P03 left this deliberately unbuilt: `platform_users` existed and
 * impersonation was built on top of it, but nothing authenticated a platform
 * user, because a platform session has no company and every token this system
 * issued carried one. The answer is a third token type rather than a nullable
 * `tid`, so no tenant handler can be reached by a platform token however the
 * routing is wired.
 *
 * A sign-in needs three things, in order:
 *
 * 1. the right password — scrypt, beside the account, because Supabase holds
 *    tenant credentials and platform identity stays outside tenant auth;
 * 2. the right six digits — always, not "if enabled". This account can read
 *    every customer's data;
 * 3. an account that is active and not locked.
 *
 * The answer to a wrong password, a wrong code, an unknown address and a
 * disabled account is the same sentence, so none of them tells an attacker
 * which they hit.
 */

export interface PlatformSignInInput {
  email: string;
  password: string;
  /** The six digits from the authenticator app. */
  code: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface PlatformSignInResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
  platformUser: { id: PlatformUserId; email: string; displayName: string };
}

export interface PlatformEnrolment {
  /** Shown once, as a QR code and as letters to type. Never stored in the clear. */
  secret: string;
  uri: string;
}

export interface PlatformSessionServiceDeps {
  tokens: TokenService;
  config: AuthConfig;
  /** Injectable clock; production does not pass one. */
  now?: () => Date;
}

export class PlatformSessionService {
  readonly #tokens: TokenService;
  readonly #config: AuthConfig;
  readonly #clock: () => Date;

  /**
   * Enrolment secrets waiting for their first code.
   *
   * In memory and short-lived on purpose: a secret nobody has proved they can
   * read a code from is not an account's second factor yet, and writing it to
   * the account would make it one — including for whoever was halfway through
   * setting it up when they closed the tab.
   */
  readonly #pending = new Map<PlatformUserId, { secret: string; expiresAt: Date }>();

  constructor(deps: PlatformSessionServiceDeps) {
    this.#tokens = deps.tokens;
    this.#config = deps.config;
    this.#clock = deps.now ?? (() => new Date());
  }

  get #key(): Buffer {
    return secretKeyFrom(this.#config.PLATFORM_SECRET_KEY);
  }

  async signIn(input: PlatformSignInInput): Promise<PlatformSignInResult> {
    const now = this.#clock();
    const platform = getPlatformDataSource();
    const account = await platform.platformUsers.credentialsFor(input.email);

    // An unknown address costs the same scrypt work as a known one, so how long
    // the answer takes does not say which addresses exist. The message is the
    // default one, identical to every other failure below: `AuthError.message`
    // reaches the caller through the API's error model, so a message that said
    // "no account with that address" would hand back exactly what the work
    // above was spent hiding.
    if (account === undefined) {
      await verifyPassword(input.password, DECOY_HASH);
      throw new InvalidCredentialsError();
    }

    if (account.lockedUntil !== null && account.lockedUntil > now) {
      throw new AccountLockedError(account.lockedUntil);
    }

    // Both factors are always checked — even when the first fails, even when
    // the account is disabled, even when it is not set up. Returning early
    // would make the response time say which half was wrong, and skipping
    // scrypt for a disabled account would make "disabled" measurable.
    // The decoy again for an account with no password yet: `verifyPassword`
    // returns false for null without doing any work, which would make "set up
    // but has no password" the one state a stopwatch can pick out.
    const passwordMatched = await verifyPassword(
      input.password,
      account.passwordHash ?? DECOY_HASH,
    );
    const codeMatched = verifyTotp(this.#unsealTotp(account.totpSecret), input.code, now);

    if (!passwordMatched || !codeMatched || !account.isActive) {
      await platform.platformUsers.recordFailure(account.id, {
        lockAfter: this.#config.PLATFORM_LOCKOUT_THRESHOLD,
        lockForMs: this.#config.PLATFORM_LOCKOUT_DURATION_SECONDS * 1000,
        now,
      });
      throw new InvalidCredentialsError();
    }

    // Raising the scrypt parameters later re-hashes on the next sign-in, which
    // is the only moment the password is in hand to do it with.
    if (needsRehash(account.passwordHash)) {
      await platform.platformUsers.setPassword(account.id, await hashPassword(input.password), now);
    }
    await platform.platformUsers.recordSignIn(account.id, now);

    return this.#issue({
      platformUserId: account.id,
      email: account.email,
      displayName: account.displayName,
      now,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  /**
   * Rotates a refresh token.
   *
   * Presenting one that has already been spent is theft, not a race: the
   * legitimate holder moved on to its replacement. The session ends, which
   * signs the real person out too — which is right, because they need to know.
   */
  async refresh(refreshToken: string): Promise<PlatformSignInResult> {
    const now = this.#clock();
    const platform = getPlatformDataSource();
    const lookup = await platform.platformSessions.lookupRefreshToken(
      hashSecret(refreshToken),
      now,
    );

    if (lookup.outcome === 'unknown') {
      throw new InvalidTokenError('Refresh token is not one this service issued');
    }
    if (lookup.outcome === 'reused') {
      await platform.platformSessions.revoke(lookup.session.id, 'refresh_token_reuse', now);
      throw new RefreshTokenReuseError(lookup.session.id);
    }
    if (lookup.outcome !== 'live') {
      throw new SessionRevokedError(
        lookup.outcome === 'expired'
          ? 'Refresh token has expired'
          : 'Platform session is over; sign in again',
      );
    }

    const account = await platform.platformUsers.findById(lookup.session.platformUserId);
    if (!account?.isActive) {
      await platform.platformSessions.revoke(lookup.session.id, 'account_disabled', now);
      throw new SessionRevokedError('Platform account is no longer active');
    }

    const secret = mintPlatformRefreshToken();
    const refreshTokenExpiresAt = new Date(
      now.getTime() + this.#config.PLATFORM_REFRESH_TOKEN_TTL_SECONDS * 1000,
    );
    const rotated = await platform.platformSessions.rotate({
      tokenId: lookup.tokenId,
      sessionId: lookup.session.id,
      refreshTokenHash: hashSecret(secret),
      refreshExpiresAt: refreshTokenExpiresAt,
      // The session's own ceiling, unchanged. Rotation must not extend a
      // platform session past the working day it was opened in.
      sessionExpiresAt: lookup.session.expiresAt,
      now,
    });

    // The token was live when we read it and spent by the time we tried to
    // spend it, so two requests presented it within the same moment. That is
    // the same fact as the `reused` branch above, arriving a few milliseconds
    // earlier, and it gets the same answer: the session ends.
    if (rotated === undefined) {
      await platform.platformSessions.revoke(lookup.session.id, 'refresh_token_reuse', now);
      throw new RefreshTokenReuseError(lookup.session.id);
    }

    const access = await this.#tokens.mintPlatformToken({
      platformUserId: account.id,
      sessionId: lookup.session.id,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: secret,
      refreshTokenExpiresAt,
      sessionId: lookup.session.id,
      platformUser: { id: account.id, email: account.email, displayName: account.displayName },
    };
  }

  /**
   * Verifies a platform access token and that the session behind it is live.
   *
   * The token alone is not enough: revoking a session has to take effect before
   * the token expires, and five minutes of a stolen super-admin token is five
   * minutes too many. One indexed lookup per request is the price.
   */
  async authenticate(token: string): Promise<PlatformPrincipal> {
    const principal = await this.#tokens.verifyPlatformToken(token);
    const now = this.#clock();
    const platform = getPlatformDataSource();

    const session = await platform.platformSessions.find(principal.sessionId);
    // One condition covers all three ways a session can be over: no such
    // session at all (`undefined?.revokedAt` is undefined, which is not null),
    // revoked, or past its ceiling.
    if (session?.revokedAt !== null || session.expiresAt <= now) {
      throw new SessionRevokedError('Platform session is over; sign in again');
    }
    if (session.platformUserId !== principal.platformUserId) {
      throw new InvalidTokenError('Platform token names a session belonging to somebody else');
    }

    const account = await platform.platformUsers.findById(principal.platformUserId);
    if (!account?.isActive) {
      await platform.platformSessions.revoke(session.id, 'account_disabled', now);
      throw new SessionRevokedError('Platform account is no longer active');
    }

    await platform.platformSessions.touch(session.id, now);
    return principal;
  }

  async signOut(sessionId: string, everywhere = false): Promise<void> {
    const now = this.#clock();
    const platform = getPlatformDataSource();
    const session = await platform.platformSessions.find(sessionId);
    if (session === undefined) {
      return;
    }
    if (everywhere) {
      await platform.platformSessions.revokeAllFor(
        session.platformUserId,
        'signed_out_everywhere',
        now,
      );
      return;
    }
    await platform.platformSessions.revoke(sessionId, 'signed_out', now);
  }

  // ---------------------------------------------------------------------------
  // Setting an account up
  // ---------------------------------------------------------------------------

  /** Sets a password and ends every session of that account: changing it signs you out. */
  async setPassword(platformUserId: PlatformUserId | string, password: string): Promise<void> {
    const now = this.#clock();
    const platform = getPlatformDataSource();
    await platform.platformUsers.setPassword(platformUserId, await hashPassword(password), now);
    await platform.platformSessions.revokeAllFor(platformUserId, 'password_changed', now);
  }

  /**
   * Starts enrolling a second factor. The secret comes back once, to be shown
   * as a QR code; it does not become the account's second factor until a code
   * from it is confirmed.
   */
  async beginTotpEnrolment(platformUserId: PlatformUserId | string): Promise<PlatformEnrolment> {
    const id = toPlatformUserId(platformUserId);
    const account = await getPlatformDataSource().platformUsers.findById(id);
    if (account === undefined) {
      throw new InvalidCredentialsError('No such platform account');
    }

    const secret = generateTotpSecret();
    this.#pending.set(id, {
      secret,
      expiresAt: new Date(this.#clock().getTime() + ENROLMENT_WINDOW_MS),
    });

    return {
      secret,
      uri: totpUri({ secret, account: account.email, issuer: this.#config.AUTH_ISSUER }),
    };
  }

  /** Confirms enrolment with a code from the new secret, and stores it encrypted. */
  async confirmTotpEnrolment(
    platformUserId: PlatformUserId | string,
    code: string,
  ): Promise<boolean> {
    const now = this.#clock();
    const id = toPlatformUserId(platformUserId);
    const pending = this.#pending.get(id);

    if (pending === undefined || pending.expiresAt <= now) {
      this.#pending.delete(id);
      return false;
    }
    if (!verifyTotp(pending.secret, code, now)) {
      return false;
    }

    this.#pending.delete(id);
    await getPlatformDataSource().platformUsers.setTotpSecret(
      id,
      sealSecret(pending.secret, this.#key),
      now,
    );
    return true;
  }

  /** What still has to happen before this account can sign in. */
  async setupNeeded(
    platformUserId: PlatformUserId | string,
  ): Promise<'password' | 'second_factor' | undefined> {
    const account = await getPlatformDataSource().platformUsers.findById(platformUserId);
    if (account === undefined) {
      throw new InvalidCredentialsError('No such platform account');
    }
    if (!account.hasPassword) {
      return 'password';
    }
    return account.totpEnrolledAt === null ? 'second_factor' : undefined;
  }

  /**
   * The stored second-factor secret, or null.
   *
   * A secret that will not decrypt — a rotated key, a corrupt row — is a failed
   * sign-in rather than a 500: the person needs to be told to ask for help, and
   * the stack trace belongs in our logs rather than on their screen.
   */
  #unsealTotp(sealed: string | null): string | null {
    if (sealed === null) {
      return null;
    }
    try {
      return openSecret(sealed, this.#key);
    } catch {
      return null;
    }
  }

  async #issue(input: {
    platformUserId: PlatformUserId;
    email: string;
    displayName: string;
    now: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<PlatformSignInResult> {
    const platform = getPlatformDataSource();
    const expiresAt = new Date(
      input.now.getTime() + this.#config.PLATFORM_SESSION_TTL_SECONDS * 1000,
    );
    const secret = mintPlatformRefreshToken();
    const refreshTokenExpiresAt = new Date(
      input.now.getTime() + this.#config.PLATFORM_REFRESH_TOKEN_TTL_SECONDS * 1000,
    );

    const { session } = await platform.platformSessions.create({
      platformUserId: input.platformUserId,
      expiresAt,
      refreshTokenHash: hashSecret(secret),
      refreshExpiresAt: refreshTokenExpiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    const access = await this.#tokens.mintPlatformToken({
      platformUserId: input.platformUserId,
      sessionId: session.id,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: secret,
      refreshTokenExpiresAt,
      sessionId: session.id,
      platformUser: {
        id: input.platformUserId,
        email: input.email,
        displayName: input.displayName,
      },
    };
  }
}

/** How long a half-finished enrolment waits for its first code. */
const ENROLMENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * A well-formed scrypt hash of a random string nobody holds, so verifying
 * against an address that does not exist costs what verifying a real one costs.
 */
const DECOY_HASH =
  'scrypt$16384$8$1$Y2xhdWRlLWRlY295LXNhbHQtdjE$ZGVjb3ktZGlnZXN0LW5vdGhpbmctbWF0Y2hlcy10aGlz';

/**
 * A platform refresh token: `i8p1.` and 256 random bits.
 *
 * Its own prefix, so a secret scanner can tell one from a tenant refresh token
 * in a log or a support ticket. Unlike `i8r1.` it carries no tenant id, because
 * it has no tenant: the session it belongs to spans the whole platform.
 */
export const PLATFORM_REFRESH_TOKEN_PREFIX = 'i8p1';

export function mintPlatformRefreshToken(): string {
  return `${PLATFORM_REFRESH_TOKEN_PREFIX}.${randomBytes(32).toString('base64url')}`;
}
