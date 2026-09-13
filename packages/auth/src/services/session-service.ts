import type { ImpersonationClaim, Role, TenantId, UserId } from '@integr8/core';
import {
  type ClientApp,
  type OfflineGrant,
  type Session,
  type SessionRevocationReason,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import type { AuthConfig } from '../config.js';
import { InvalidTokenError, RefreshTokenReuseError, SessionRevokedError } from '../errors.js';
import { mintRefreshToken, parseRefreshToken } from '../secrets.js';
import type { TokenService } from '../tokens.js';

/**
 * Sessions: issuing them, rotating them, ending them.
 *
 * The one place that mints a credential a client keeps, and therefore the one
 * place that decides how long anything lasts.
 */

/** What the refresh transaction decided, acted on only once it has committed. */
type RefreshOutcome =
  | { kind: 'issued'; session: IssuedSession }
  | { kind: 'reused'; sessionId: string }
  | { kind: 'membership_ended' };

export interface IssuedSession {
  session: Session;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface IssueSessionInput {
  tenantId: TenantId;
  userId: UserId;
  role: Role;
  clientApp: ClientApp;
  deviceLabel?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  /** Set only when a super admin is impersonating; see ImpersonationService. */
  impersonationGrantId?: string | null;
}

export interface SessionServiceDeps {
  tokens: TokenService;
  config: AuthConfig;
  now?: () => Date;
}

export class SessionService {
  readonly #tokens: TokenService;
  readonly #config: AuthConfig;
  readonly #clock: () => Date;

  constructor(deps: SessionServiceDeps) {
    this.#tokens = deps.tokens;
    this.#config = deps.config;
    this.#clock = deps.now ?? (() => new Date());
  }

  /**
   * Creates a session and its first token pair.
   *
   * Takes an open transaction because every caller — sign-in, tenant switch,
   * invitation acceptance, impersonation — has already done tenant work that
   * must succeed or fail together with this. A session created beside a
   * membership that was rolled back is a session for somebody who is not a
   * member.
   */
  async issue(tx: TenantTransaction, input: IssueSessionInput): Promise<IssuedSession> {
    const now = this.#clock();

    const session = await tx.sessions.create({
      userId: input.userId,
      clientApp: input.clientApp,
      deviceLabel: input.deviceLabel ?? null,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      impersonationGrantId: input.impersonationGrantId ?? null,
      expiresAt: new Date(now.getTime() + this.#config.AUTH_SESSION_MAX_TTL_SECONDS * 1000),
    });

    return (await this.#issuePair(tx, session, input.role, now, input.impersonationGrantId ?? null))
      .session;
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * Five things are checked, in an order chosen so the most serious is found
   * first: has this token already been spent (theft), has it expired, has the
   * session been revoked, has the session outlived its maximum, is the
   * membership still active.
   *
   * The membership check is what makes a role change take effect within one
   * access-token lifetime rather than whenever the person next signs in — and
   * what stops somebody who left the company on Friday from refreshing their
   * way through the weekend.
   */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed === undefined) {
      throw new InvalidTokenError('Refresh token is malformed');
    }

    const now = this.#clock();

    // The transaction decides and records; the caller is refused only after it
    // has committed.
    //
    // Two outcomes here write something *and* refuse the request: a spent token
    // coming back, and a membership that has ended. Throwing from inside the
    // transaction rolled those writes back along with everything else — so a
    // replayed refresh token was refused while the session it belonged to stayed
    // alive and nothing reached the audit log, and a removed member's offline
    // grant survived for its full seven days. The refusal was right and its
    // consequences never happened. The integration suite found it the first time
    // it ran against a real database; the unit tests use a store with no
    // transactions, where a throw rolls nothing back.
    const outcome = await withTenant(parsed.tenantId, async (tx): Promise<RefreshOutcome> => {
      const record = await tx.sessions.findRefreshTokenByHash(parsed.hash);
      if (record === undefined) {
        throw new InvalidTokenError('Refresh token is not recognised');
      }

      const session = await tx.sessions.findById(record.sessionId);
      if (session === undefined) {
        throw new InvalidTokenError('Refresh token names a session that does not exist');
      }

      if (record.usedAt !== null) {
        await this.#recordReuse(tx, session, now);
        return { kind: 'reused', sessionId: session.id };
      }

      if (record.expiresAt <= now) {
        throw new InvalidTokenError('Refresh token has expired');
      }
      if (session.revokedAt !== null) {
        throw new SessionRevokedError(
          `Session was revoked (${session.revokedReason ?? 'unknown'})`,
        );
      }
      if (session.expiresAt <= now) {
        throw new SessionRevokedError('Session has reached its maximum lifetime');
      }

      const membership = await tx.tenantUsers.findByUserId(session.userId);
      if (membership?.status !== 'active') {
        await tx.sessions.revoke(session.id, 'membership_ended', now);
        await tx.offlineGrants.revokeForSession(session.id, 'membership_ended', now);
        return { kind: 'membership_ended' };
      }

      const issued = await this.#issuePair(
        tx,
        session,
        membership.role,
        now,
        session.impersonationGrantId,
      );

      // Claiming the old token is the concurrency control: `where used_at is
      // null` means exactly one of two racing refreshes wins. The loser is
      // treated as reuse, which is the safe reading — a client refreshing twice
      // at once looks identical to a thief racing the real client.
      const claimed = await tx.sessions.markRefreshTokenUsed(record.id, issued.refreshTokenId, now);
      if (!claimed) {
        // The pair just issued is committed with the rest, and is worthless:
        // it belongs to the session being revoked on the next line.
        await this.#recordReuse(tx, session, now);
        return { kind: 'reused', sessionId: session.id };
      }

      await tx.sessions.touch(session.id, now);

      return { kind: 'issued', session: issued.session };
    });

    switch (outcome.kind) {
      case 'reused':
        throw new RefreshTokenReuseError(outcome.sessionId);
      case 'membership_ended':
        throw new SessionRevokedError('Membership is no longer active');
      case 'issued':
        return outcome.session;
    }
  }

  /** Ends one session, and any offline grant that would have outlived it. */
  async revoke(
    tenantId: TenantId,
    sessionId: string,
    reason: SessionRevocationReason,
  ): Promise<boolean> {
    const now = this.#clock();

    return withTenant(tenantId, async (tx) => {
      const revoked = await tx.sessions.revoke(sessionId, reason, now);
      if (revoked) {
        // Without this the device would be logged out of the API and still able
        // to open and work offline for another week — the opposite of what the
        // admin who clicked "revoke" meant.
        await tx.offlineGrants.revokeForSession(sessionId, 'session_revoked', now);
      }
      return revoked;
    });
  }

  /** Ends every session for one person in one company. */
  async revokeAllForUser(
    tenantId: TenantId,
    userId: UserId,
    reason: SessionRevocationReason,
    options: { except?: string } = {},
  ): Promise<number> {
    const now = this.#clock();

    return withTenant(tenantId, async (tx) => {
      const sessions = await tx.sessions.list({ userId, limit: 500 }, now);
      const count = await tx.sessions.revokeAllForUser(userId, reason, options, now);

      for (const session of sessions) {
        if (session.id !== options.except) {
          await tx.offlineGrants.revokeForSession(session.id, 'session_revoked', now);
        }
      }

      return count;
    });
  }

  /** The device list an admin or a person sees. */
  async list(
    tenantId: TenantId,
    options: { userId?: UserId; includeRevoked?: boolean } = {},
  ): Promise<Session[]> {
    const now = this.#clock();
    return withTenant(tenantId, (tx) => tx.sessions.list(options, now));
  }

  // -------------------------------------------------------------------------
  // Offline access
  // -------------------------------------------------------------------------

  /**
   * Issues the grant that lets the mobile app open with no network.
   *
   * Only ever for `mobile`. The desktop and web apps have no offline story in
   * this product and handing them a week-long credential would be a liability
   * with no benefit.
   */
  async issueOfflineGrant(input: {
    tenantId: TenantId;
    sessionId: string;
    userId: UserId;
    role: Role;
    deviceLabel?: string | null;
  }): Promise<{ grant: OfflineGrant; token: string; expiresAt: Date }> {
    const now = this.#clock();

    return withTenant(input.tenantId, async (tx) => {
      const session = await tx.sessions.findById(input.sessionId);
      if (session === undefined) {
        throw new SessionRevokedError('Cannot issue an offline grant for an unknown session');
      }
      if (session.revokedAt !== null || session.expiresAt <= now) {
        throw new SessionRevokedError('Cannot issue an offline grant for an inactive session');
      }
      if (session.clientApp !== 'mobile') {
        throw new SessionRevokedError('Offline grants are issued to the mobile app only');
      }

      // One live grant per device: a new one supersedes the last, so a phone
      // that has been re-registered does not leave a second usable credential
      // behind it.
      await tx.offlineGrants.revokeForSession(input.sessionId, 'replaced', now);

      const grant = await tx.offlineGrants.create({
        sessionId: input.sessionId,
        userId: input.userId,
        deviceLabel: input.deviceLabel ?? session.deviceLabel,
        expiresAt: new Date(now.getTime() + this.#config.AUTH_OFFLINE_GRANT_TTL_SECONDS * 1000),
      });

      const minted = await this.#tokens.mintOfflineGrant({
        userId: input.userId,
        tenantId: input.tenantId,
        role: input.role,
        sessionId: input.sessionId,
        grantId: grant.id,
      });

      return { grant, token: minted.token, expiresAt: minted.expiresAt };
    });
  }

  /** Revokes a grant — the "I have lost my phone" path. */
  async revokeOfflineGrant(tenantId: TenantId, grantId: string): Promise<boolean> {
    const now = this.#clock();
    return withTenant(tenantId, (tx) => tx.offlineGrants.revoke(grantId, 'device_lost', now));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #issuePair(
    tx: TenantTransaction,
    session: Session,
    role: Role,
    now: Date,
    impersonationGrantId: string | null,
  ): Promise<{ session: IssuedSession; refreshTokenId: string }> {
    const refresh = mintRefreshToken(session.tenantId);

    // A refresh token never outlives the session it belongs to, so rotation
    // cannot extend a session past its maximum lifetime one hop at a time.
    const refreshExpiresAt = earlier(
      new Date(now.getTime() + this.#config.AUTH_REFRESH_TOKEN_TTL_SECONDS * 1000),
      session.expiresAt,
    );

    const record = await tx.sessions.issueRefreshToken({
      sessionId: session.id,
      tokenHash: refresh.hash,
      expiresAt: refreshExpiresAt,
    });

    const impersonation =
      impersonationGrantId === null
        ? undefined
        : await this.#impersonationClaim(tx, impersonationGrantId);

    const access = await this.#tokens.mintAccessToken({
      userId: session.userId,
      tenantId: session.tenantId,
      role,
      sessionId: session.id,
      impersonation,
    });

    return {
      session: {
        session,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: refresh.token,
        refreshTokenExpiresAt: refreshExpiresAt,
      },
      refreshTokenId: record.id,
    };
  }

  async #impersonationClaim(
    tx: TenantTransaction,
    grantId: string,
  ): Promise<ImpersonationClaim | undefined> {
    const grant = await tx.impersonation.findById(grantId);
    return grant === undefined ? undefined : { pid: grant.platformUserId, gid: grant.id };
  }

  /**
   * A spent refresh token was presented. Treat it as theft and end the session.
   *
   * The legitimate holder is logged out too. That is the right outcome: if the
   * token really was stolen, the person needs to notice, and a silent recovery
   * would hide the only evidence there is.
   */
  /**
   * Kills the session a spent token belongs to, and says so in the audit log.
   *
   * Returns rather than throws: the caller has to let the transaction commit
   * before refusing the request, or none of this survives. See `refresh`.
   */
  async #recordReuse(tx: TenantTransaction, session: Session, now: Date): Promise<void> {
    await tx.sessions.revoke(session.id, 'refresh_token_reuse', now);
    await tx.offlineGrants.revokeForSession(session.id, 'session_revoked', now);
    await tx.auditLog.append({
      actorKind: 'system',
      actorLabel: 'system',
      action: 'session.refresh_token_reused',
      resourceType: 'session',
      resourceId: session.id,
      metadata: {
        userId: session.userId,
        clientApp: session.clientApp,
        detail: 'A refresh token was presented after it had already been spent.',
      },
    });
  }
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
