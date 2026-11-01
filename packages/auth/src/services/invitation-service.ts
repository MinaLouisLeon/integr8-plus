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
import {
  InvitationInvalidError,
  InvitationPasswordRequiredError,
  WeakPasswordError,
} from '../errors.js';
import type { IdentityProvider } from '../identity-provider.js';
import { assessPassword } from '../password-policy.js';
import { mintInvitationToken, parseInvitationToken } from '../secrets.js';

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
  /**
   * Required when the address has no identity yet: it becomes their password.
   * Ignored when it has one — see {@link InvitationService.accept}.
   */
  password?: string;
  displayName: string;
  /** Which app accepted, for the audit line. No session is made for it. */
  clientApp: ClientApp;
}

export interface AcceptInvitationResult {
  tenantId: TenantId;
  userId: UserId;
  /** The address the invitation was sent to. The caller decides who may see it. */
  email: string;
  /** The address already had a sign-in, whose password is unchanged. */
  existingAccount: boolean;
}

/** What the holder of a live invitation link may know before accepting it. */
export interface InvitationSummary {
  /** The address it was sent to, which is who will sign in. */
  email: string;
  /** No sign-in exists for the address yet, so accepting must choose a password. */
  passwordRequired: boolean;
}

export interface InvitationServiceDeps {
  identity: IdentityProvider;
  config: AuthConfig;
  now?: () => Date;
  /**
   * Asked, before a seat is taken, whether the company may take one (P17).
   *
   * Injected rather than imported: what a plan allows is a billing question,
   * and this package knows nothing about plans or providers. It throws to
   * refuse; the error travels out of `accept` unchanged, so the caller decides
   * what an over-quota acceptance looks like on the wire.
   *
   * Optional, and absent means no limit — the seat rule is enforced by
   * whoever is enforcing plans, not by the fact that somebody remembered to
   * pass a callback here.
   */
  seatCheck?: (tenantId: TenantId) => Promise<void>;
}

export class InvitationService {
  readonly #identity: IdentityProvider;
  readonly #config: AuthConfig;
  readonly #clock: () => Date;
  readonly #seatCheck: ((tenantId: TenantId) => Promise<void>) | undefined;

  constructor(deps: InvitationServiceDeps) {
    this.#identity = deps.identity;
    this.#config = deps.config;
    this.#clock = deps.now ?? (() => new Date());
    this.#seatCheck = deps.seatCheck;
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
   * The invitation behind a link, for the page that accepts it: who it is
   * for, and whether they must choose a password.
   *
   * Says no more than accepting would: the holder of a live token learns the
   * address the link was mailed to and whether it already signs in somewhere,
   * and an invalid token is the same one error as at acceptance.
   */
  async inspect(token: string): Promise<InvitationSummary> {
    const { invitation } = await this.#live(token);
    const identity = await this.#identity.findByEmail(invitation.email);
    return { email: invitation.email, passwordRequired: identity === undefined };
  }

  /**
   * Accepts an invitation, creating the membership. **No session is made**
   * (Low 5, 1.2.4): the person signs in afterwards, with the address the
   * invitation was sent to, like anybody else.
   *
   * The invitation token travels by email and may sit in a mailbox, a proxy
   * log or a screenshot. Signing in on the strength of it alone made every one
   * of those a way in; requiring the ordinary sign-in afterwards means the
   * token buys a membership and nothing a password does not already guard.
   *
   * An address with no identity yet must choose a password here, and it must
   * pass the password policy, including not containing the address's local
   * part. An address that already signs in (a member of another company,
   * somebody removed and invited back) keeps the password it has: one sent
   * anyway is ignored, because changing a credential that is also another
   * company's sign-in is not what accepting an invitation means, and the
   * result says `existingAccount` so the screen can say which password to use.
   *
   * The company comes from the token, not from the request: an invitation to
   * one company cannot be redeemed against another, because there is no
   * parameter in which to name a different one.
   *
   * Everything tenant-side happens in one transaction, so a failure part-way
   * cannot leave a membership without an accepted invitation, or the reverse.
   */
  async accept(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    const { invitation, tenantId, now } = await this.#live(input.token);

    // Before the identity is created, not after: an acceptance refused for
    // want of a seat must leave nothing behind at the identity provider, and
    // `createIdentity` is the first step that is not ours to undo.
    //
    // Checked here as well as at invitation because the two moments are weeks
    // apart. The plan can shrink, or the last seat can be taken by somebody
    // else, between the invitation being sent and the link being clicked.
    if (this.#seatCheck !== undefined) {
      await this.#seatCheck(tenantId);
    }

    // The address may have an identity already. The invitation arrived in that
    // mailbox, which is the same proof of ownership creating one would rest
    // on, so the existing identity is used. Creating unconditionally was
    // refused by GoTrue as a duplicate and the invitation could never be
    // accepted; the fake provider hid it by returning the existing identity.
    const existing = await this.#identity.findByEmail(invitation.email);
    let identity = existing;
    if (identity === undefined) {
      // A new identity needs a password, checked before anything is created.
      if (input.password === undefined || input.password === '') {
        throw new InvitationPasswordRequiredError();
      }
      const assessment = assessPassword(
        input.password,
        { minLength: this.#config.AUTH_MIN_PASSWORD_LENGTH },
        { email: invitation.email },
      );
      if (!assessment.acceptable) {
        throw new WeakPasswordError(assessment.problems);
      }
      identity = await this.#identity.createIdentity(invitation.email, input.password);
    }
    const userId = identity.userId;

    await withTenant(tenantId, async (tx) => {
      // Re-checked inside the transaction. Two people clicking the same link at
      // once both passed the check above; the `where` clauses inside
      // `markAccepted` let exactly one of them through.
      const claimed = await tx.invitations.markAccepted(invitation.id, userId, now);
      if (!claimed) {
        throw new InvitationInvalidError();
      }

      await tx.tenantUsers.create({
        userId,
        email: invitation.email,
        displayName: input.displayName,
        role: invitation.role,
        status: 'active',
      });

      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: userId,
        actorLabel: invitation.email,
        action: 'invitation.accepted',
        resourceType: 'invitation',
        resourceId: invitation.id,
        metadata: {
          role: invitation.role,
          invitedBy: invitation.invitedByUserId,
          clientApp: input.clientApp,
          existingAccount: existing !== undefined,
        },
      });
    });

    return {
      tenantId,
      userId,
      email: invitation.email,
      existingAccount: existing !== undefined,
    };
  }

  /** The live invitation a token names, or {@link InvitationInvalidError}. */
  async #live(token: string): Promise<{ invitation: Invitation; tenantId: TenantId; now: Date }> {
    const parsed = parseInvitationToken(token);
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

    return { invitation, tenantId: parsed.tenantId, now };
  }
}
