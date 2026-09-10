import {
  assertCan,
  type Principal,
  type Role,
  roleRank,
  type TenantId,
  type UserId,
} from '@integr8/core';
import { type ClientApp, type Invitation, withTenant } from '@integr8/db';
import type { AuthConfig } from '../config.js';
import { InvitationInvalidError, WeakPasswordError } from '../errors.js';
import type { IdentityProvider } from '../identity-provider.js';
import { assessPassword } from '../password-policy.js';
import { mintInvitationToken, parseInvitationToken } from '../secrets.js';
import type { IssuedSession, SessionService } from './session-service.js';

/**
 * Invitations: how somebody becomes a member of a company.
 *
 * An invitation is a capability, not a notification. Holding the token is what
 * grants membership, so the token is 256 random bits, is stored only as a hash,
 * expires, and can be withdrawn — and the role it confers is fixed when it is
 * sent rather than chosen by whoever accepts it.
 */

export interface CreateInvitationResult {
  invitation: Invitation;
  /**
   * The token to put in the email.
   *
   * Returned exactly once and never recoverable: only its hash is stored.
   * Callers must not log it.
   */
  token: string;
}

export interface AcceptInvitationInput {
  token: string;
  /** Set when the invitee has no identity yet and is choosing a password. */
  password?: string;
  displayName: string;
  clientApp: ClientApp;
  deviceLabel?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface AcceptInvitationResult {
  tokens: IssuedSession;
  tenantId: TenantId;
  userId: UserId;
}

export interface InvitationServiceDeps {
  identity: IdentityProvider;
  sessions: SessionService;
  config: AuthConfig;
  now?: () => Date;
}

export class InvitationService {
  readonly #identity: IdentityProvider;
  readonly #sessions: SessionService;
  readonly #config: AuthConfig;
  readonly #clock: () => Date;

  constructor(deps: InvitationServiceDeps) {
    this.#identity = deps.identity;
    this.#sessions = deps.sessions;
    this.#config = deps.config;
    this.#clock = deps.now ?? (() => new Date());
  }

  /**
   * Invites somebody, at a role chosen now.
   *
   * The inviter cannot grant a role they do not hold themselves. Without that
   * rule, `member.invite` is `member.promote_self`: an admin invites their own
   * second address as an owner and the role hierarchy is decorative.
   */
  async invite(
    principal: Principal,
    input: { email: string; role: Role },
  ): Promise<CreateInvitationResult> {
    assertCan(principal.role, 'member.invite');

    if (roleRank(input.role) > roleRank(principal.role)) {
      throw new InvitationInvalidError(
        `A ${principal.role} cannot invite somebody as ${input.role}`,
      );
    }

    const now = this.#clock();
    const email = input.email.trim().toLowerCase();
    const secret = mintInvitationToken(principal.tenantId);

    const invitation = await withTenant(principal.tenantId, async (tx) => {
      const existingMember = await tx.tenantUsers.findByEmail(email);
      if (existingMember !== undefined) {
        throw new InvitationInvalidError('That address is already a member of this company');
      }

      // The partial unique index allows one live invitation per address, so an
      // existing one is withdrawn rather than left to collide.
      const live = await tx.invitations.findLiveByEmail(email);
      if (live !== undefined) {
        await tx.invitations.revoke(live.id, principal.userId, now);
      }

      const created = await tx.invitations.create({
        email,
        role: input.role,
        invitedByUserId: principal.userId,
        tokenHash: secret.hash,
        expiresAt: new Date(now.getTime() + this.#config.AUTH_INVITATION_TTL_SECONDS * 1000),
      });

      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: principal.userId,
        actorLabel: principal.userId,
        action: 'invitation.created',
        resourceType: 'invitation',
        resourceId: created.id,
        metadata: { email, role: input.role },
      });

      return created;
    });

    return { invitation, token: secret.token };
  }

  async revoke(principal: Principal, invitationId: string): Promise<boolean> {
    assertCan(principal.role, 'invitation.revoke');
    const now = this.#clock();

    return withTenant(principal.tenantId, async (tx) => {
      const revoked = await tx.invitations.revoke(invitationId, principal.userId, now);
      if (revoked) {
        await tx.auditLog.append({
          actorKind: 'tenant_user',
          actorId: principal.userId,
          actorLabel: principal.userId,
          action: 'invitation.revoked',
          resourceType: 'invitation',
          resourceId: invitationId,
        });
      }
      return revoked;
    });
  }

  async listPending(principal: Principal): Promise<Invitation[]> {
    assertCan(principal.role, 'invitation.read');
    return withTenant(principal.tenantId, (tx) => tx.invitations.listPending());
  }

  /**
   * Accepts an invitation, creating the membership and signing the person in.
   *
   * The company comes from the token, not from the request: an invitation to
   * one company cannot be redeemed against another, because there is no
   * parameter in which to name a different one.
   *
   * Everything tenant-side happens in one transaction, so a failure part-way
   * cannot leave a membership without an accepted invitation, or the reverse.
   */
  async accept(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    const parsed = parseInvitationToken(input.token);
    if (parsed === undefined) {
      throw new InvitationInvalidError();
    }

    const now = this.#clock();

    // Reading the invitation before creating the identity keeps a bad token
    // from provisioning an account at the identity provider.
    const invitation = await withTenant(parsed.tenantId, (tx) =>
      tx.invitations.findByTokenHash(parsed.hash),
    );

    if (invitation === undefined) {
      throw new InvitationInvalidError();
    }
    // Accepted, withdrawn and expired are one error to the caller. Telling a
    // stranger which of the three it was tells them the link was once real.
    if (
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt <= now
    ) {
      throw new InvitationInvalidError();
    }

    if (input.password !== undefined) {
      const assessment = assessPassword(
        input.password,
        { minLength: this.#config.AUTH_MIN_PASSWORD_LENGTH },
        { email: invitation.email },
      );
      if (!assessment.acceptable) {
        throw new WeakPasswordError(assessment.problems);
      }
    }

    const identity = await this.#identity.createIdentity(invitation.email, input.password ?? '');

    const tokens = await withTenant(parsed.tenantId, async (tx) => {
      // Re-checked inside the transaction. Two people clicking the same link at
      // once both passed the check above; the `where` clauses inside
      // `markAccepted` let exactly one of them through.
      const claimed = await tx.invitations.markAccepted(invitation.id, identity.userId, now);
      if (!claimed) {
        throw new InvitationInvalidError();
      }

      await tx.tenantUsers.create({
        userId: identity.userId,
        email: invitation.email,
        displayName: input.displayName,
        role: invitation.role,
        status: 'active',
      });

      const issued = await this.#sessions.issue(tx, {
        tenantId: parsed.tenantId,
        userId: identity.userId,
        role: invitation.role,
        clientApp: input.clientApp,
        deviceLabel: input.deviceLabel ?? null,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
      });

      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: identity.userId,
        actorLabel: invitation.email,
        action: 'invitation.accepted',
        resourceType: 'invitation',
        resourceId: invitation.id,
        metadata: { role: invitation.role, invitedBy: invitation.invitedByUserId },
      });

      return issued;
    });

    return { tokens, tenantId: parsed.tenantId, userId: identity.userId };
  }
}
