import type { PlatformUserId, Principal, TenantId, UserId } from '@integr8/core';
import { type ClientApp, getPlatformDataSource, withTenant } from '@integr8/db';
import type { AuthConfig } from '../config.js';
import { ImpersonationDeniedError } from '../errors.js';
import type { IssuedSession, SessionService } from './session-service.js';

/**
 * A super admin acting as a tenant user, briefly, on record.
 *
 * The thing this has to get right is ordering. P03 requires that the audit
 * entry be written *before* access is granted, and the reason is the failure
 * case: if the entry is written afterwards, a crash in between leaves someone
 * having read a customer's data with nothing to say they did.
 *
 * So the order is: write the audit entry, create a grant that carries a
 * non-null foreign key to it, then mint a token. There is no arrangement in
 * which the grant exists and the entry does not, because the insert would fail
 * — and `audit_log` rejects updates and deletes for every role including the
 * owner, so the entry cannot be removed afterwards either. Together those two
 * facts are P03's second exit criterion, held up by the schema rather than by
 * this function being careful.
 */

export interface StartImpersonationInput {
  platformUserId: PlatformUserId;
  tenantId: TenantId;
  targetUserId: UserId;
  /** Free text, at least ten characters. A check constraint enforces it. */
  reason: string;
  clientApp: ClientApp;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface StartImpersonationResult {
  tokens: IssuedSession;
  grantId: string;
  expiresAt: Date;
}

export interface ImpersonationServiceDeps {
  sessions: SessionService;
  config: AuthConfig;
  now?: () => Date;
}

export class ImpersonationService {
  readonly #sessions: SessionService;
  readonly #config: AuthConfig;
  readonly #clock: () => Date;

  constructor(deps: ImpersonationServiceDeps) {
    this.#sessions = deps.sessions;
    this.#config = deps.config;
    this.#clock = deps.now ?? (() => new Date());
  }

  async start(input: StartImpersonationInput): Promise<StartImpersonationResult> {
    const now = this.#clock();
    const reason = input.reason.trim();

    if (reason.length < 10) {
      throw new ImpersonationDeniedError(
        'A reason of at least ten characters is required. It is read by the customer whose account this is.',
      );
    }

    // The platform identity is checked over the platform connection, because a
    // tenant request must never be able to see `platform_users` at all.
    const platform = getPlatformDataSource();
    const platformUsers = await platform.platformUsers.list();
    const actor = platformUsers.find((candidate) => candidate.id === input.platformUserId);

    if (!actor?.isActive) {
      throw new ImpersonationDeniedError('Not an active platform user');
    }

    const expiresAt = new Date(now.getTime() + this.#config.AUTH_IMPERSONATION_TTL_SECONDS * 1000);

    const { tokens, grantId } = await withTenant(input.tenantId, async (tx) => {
      const target = await tx.tenantUsers.findByUserId(input.targetUserId);
      if (target === undefined) {
        throw new ImpersonationDeniedError('Target is not a member of that company');
      }

      // Step one, and it is a step rather than a line: everything below depends
      // on this row existing.
      const entry = await tx.auditLog.append({
        actorKind: 'platform_user',
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'impersonation.started',
        resourceType: 'tenant_user',
        resourceId: input.targetUserId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        metadata: {
          reason,
          targetRole: target.role,
          expiresAt: expiresAt.toISOString(),
        },
      });

      const grant = await tx.impersonation.create({
        platformUserId: actor.id,
        targetUserId: input.targetUserId,
        reason,
        auditLogId: entry.id,
        expiresAt,
      });

      const issued = await this.#sessions.issue(tx, {
        tenantId: input.tenantId,
        userId: input.targetUserId,
        role: target.role,
        clientApp: input.clientApp,
        deviceLabel: `impersonation by ${actor.email}`,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        impersonationGrantId: grant.id,
      });

      return { tokens: issued, grantId: grant.id };
    });

    return { tokens, grantId, expiresAt };
  }

  /** Ends a grant and the session minted under it. */
  async end(
    grantId: string,
    tenantId: TenantId,
    reason: 'ended_by_admin' | 'revoked_by_tenant',
  ): Promise<boolean> {
    const now = this.#clock();

    const sessionIds = await withTenant(tenantId, async (tx) => {
      const grant = await tx.impersonation.findById(grantId);
      if (grant === undefined) {
        return [];
      }

      const ended = await tx.impersonation.end(grantId, reason, now);
      if (!ended) {
        return [];
      }

      await tx.auditLog.append({
        actorKind: 'platform_user',
        actorId: grant.platformUserId,
        actorLabel: grant.platformUserId,
        action: 'impersonation.ended',
        resourceType: 'tenant_user',
        resourceId: grant.targetUserId,
        metadata: { grantId, reason },
      });

      const sessions = await tx.sessions.list({ includeRevoked: false, limit: 500 }, now);
      return sessions
        .filter((session) => session.impersonationGrantId === grantId)
        .map((session) => session.id);
    });

    for (const sessionId of sessionIds) {
      await this.#sessions.revoke(tenantId, sessionId, 'impersonation_ended');
    }

    return sessionIds.length > 0;
  }

  /**
   * Checks that a request made under an impersonation token may still proceed.
   *
   * Called on every such request rather than trusting the token's own expiry,
   * so that ending a session takes effect immediately instead of whenever the
   * access token happens to lapse. Fifteen minutes of a super admin inside a
   * customer's account after the customer asked them to stop is fifteen minutes
   * too many.
   */
  async assertStillPermitted(principal: Principal): Promise<void> {
    const impersonation = principal.impersonatedBy;
    if (impersonation === undefined) {
      return;
    }

    const now = this.#clock();
    const grant = await withTenant(principal.tenantId, (tx) =>
      tx.impersonation.findLive(impersonation.gid, now),
    );

    if (grant === undefined) {
      throw new ImpersonationDeniedError('This impersonation grant has ended or expired');
    }
    if (grant.targetUserId !== principal.userId) {
      throw new ImpersonationDeniedError('Grant does not cover this user');
    }
  }

  /** Every grant against one company. An owner is owed this on request. */
  async listForTenant(tenantId: TenantId) {
    return withTenant(tenantId, (tx) => tx.impersonation.list());
  }
}
