import type { Principal, TenantId, UserId } from '@integr8/core';
import {
  type AuthMembership,
  type ClientApp,
  getAuthDataSource,
  isLocked,
  isUsableMembership,
  type LockPolicy,
  type LoginOutcome,
  withTenant,
} from '@integr8/db';
import type { AuthConfig } from '../config.js';
import {
  AccountLockedError,
  ImpersonationDeniedError,
  InvalidCredentialsError,
  NotAMemberError,
  RateLimitedError,
} from '../errors.js';
import type { IdentityProvider, VerifiedIdentity } from '../identity-provider.js';
import type { IssuedSession, SessionService } from './session-service.js';

/**
 * Signing in, and choosing which company to sign in to.
 *
 * The shape of this file is dictated by one fact: at the moment a sign-in
 * arrives, there is no tenant. Rate limiting, lockout and "which companies does
 * this person belong to" all happen over the pre-authentication connection,
 * whose role can reach two tables and one view. Only once a company has been
 * chosen does anything touch tenant data, and from that point everything goes
 * through the ordinary tenant path with RLS armed.
 */

export interface SignInInput {
  email: string;
  password: string;
  clientApp: ClientApp;
  /** Which company to sign in to. Defaults to the only one, or the first. */
  tenantId?: TenantId;
  deviceLabel?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface SignInResult {
  tokens: IssuedSession;
  tenantId: TenantId;
  userId: UserId;
  /**
   * Every company this person belongs to.
   *
   * Returned even when there is only one, so the client can render a switcher
   * without a second round trip — and so signing in never has to be a two-step
   * flow with a token in between just to answer "which company?".
   */
  memberships: AuthMembership[];
}

export interface SignInServiceDeps {
  identity: IdentityProvider;
  sessions: SessionService;
  config: AuthConfig;
  now?: () => Date;
}

export class SignInService {
  readonly #identity: IdentityProvider;
  readonly #sessions: SessionService;
  readonly #config: AuthConfig;
  readonly #clock: () => Date;

  constructor(deps: SignInServiceDeps) {
    this.#identity = deps.identity;
    this.#sessions = deps.sessions;
    this.#config = deps.config;
    this.#clock = deps.now ?? (() => new Date());
  }

  get #lockPolicy(): LockPolicy {
    return {
      threshold: this.#config.AUTH_LOCKOUT_THRESHOLD,
      lockDurationMs: this.#config.AUTH_LOCKOUT_DURATION_SECONDS * 1000,
      windowMs: this.#config.AUTH_LOCKOUT_WINDOW_SECONDS * 1000,
    };
  }

  async signInWithPassword(input: SignInInput): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    const now = this.#clock();
    const auth = await getAuthDataSource();

    await this.#guardRate(email, input, now);

    const lock = await auth.loginSecurity.findLock(email);
    if (isLocked(lock, now) && lock?.lockedUntil != null) {
      await this.#record(email, 'locked_out', input);
      throw new AccountLockedError(lock.lockedUntil);
    }

    let identity: VerifiedIdentity;
    try {
      identity = await this.#identity.signInWithPassword(email, input.password);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        await this.#record(email, 'bad_credentials', input);
        await auth.loginSecurity.registerFailure(email, this.#lockPolicy, now);
      }
      throw error;
    }

    return this.#completeSignIn(identity, input, email);
  }

  /**
   * Sends a magic link.
   *
   * Resolves the same way whether or not the address is known. An endpoint that
   * answered "no such account" would be a free membership oracle: paste in a
   * list of addresses, learn which ones are customers.
   */
  async sendMagicLink(email: string, redirectTo: string): Promise<void> {
    await this.#identity.sendMagicLink(email.trim().toLowerCase(), redirectTo);
  }

  /** Completes a magic-link sign-in. Lockout applies here too. */
  async completeMagicLink(
    input: Omit<SignInInput, 'password'> & { token: string },
  ): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    const now = this.#clock();
    const auth = await getAuthDataSource();
    const withPassword = { ...input, password: '' };

    await this.#guardRate(email, withPassword, now);

    const lock = await auth.loginSecurity.findLock(email);
    if (isLocked(lock, now) && lock?.lockedUntil != null) {
      await this.#record(email, 'locked_out', withPassword);
      throw new AccountLockedError(lock.lockedUntil);
    }

    let identity: VerifiedIdentity;
    try {
      identity = await this.#identity.verifyMagicLink(input.token, email);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        await this.#record(email, 'bad_credentials', withPassword);
        await auth.loginSecurity.registerFailure(email, this.#lockPolicy, now);
      }
      throw error;
    }

    return this.#completeSignIn(identity, withPassword, email);
  }

  /**
   * Moves an authenticated person to another of their companies.
   *
   * Holding a valid token for company A says nothing whatever about company B,
   * so membership is checked afresh here rather than inferred. The old session
   * is then revoked: a device holds one session at a time, which is what makes
   * "sign out" and "revoke this device" mean something definite.
   */
  async switchTenant(
    principal: Principal,
    targetTenantId: TenantId,
    input: {
      clientApp: ClientApp;
      deviceLabel?: string | null;
      userAgent?: string | null;
      ipAddress?: string | null;
    },
  ): Promise<SignInResult> {
    // A grant covers one company. The session this issues carries no grant, so
    // it would be a plain session as the target, in a company whose owner never
    // consented, lasting the full session ceiling, and invisible to `end()`.
    if (principal.impersonatedBy !== undefined) {
      throw new ImpersonationDeniedError(
        'An impersonation grant covers one company; it cannot be carried to another',
      );
    }

    const auth = await getAuthDataSource();
    const membership = await auth.memberships.find(principal.userId, targetTenantId);

    if (membership === undefined || !isUsableMembership(membership)) {
      throw new NotAMemberError(targetTenantId);
    }

    const tokens = await withTenant(targetTenantId, async (tx) => {
      const issued = await this.#sessions.issue(tx, {
        tenantId: targetTenantId,
        userId: principal.userId,
        role: membership.role,
        clientApp: input.clientApp,
        deviceLabel: input.deviceLabel ?? null,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
      });

      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: principal.userId,
        actorLabel: principal.userId,
        action: 'auth.tenant_switched',
        resourceType: 'session',
        resourceId: issued.session.id,
        metadata: { from: principal.tenantId, clientApp: input.clientApp },
      });

      return issued;
    });

    await this.#sessions.revoke(principal.tenantId, principal.sessionId, 'signed_out');

    return {
      tokens,
      tenantId: targetTenantId,
      userId: principal.userId,
      memberships: await auth.memberships.listForUser(principal.userId),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #completeSignIn(
    identity: VerifiedIdentity,
    input: SignInInput,
    email: string,
  ): Promise<SignInResult> {
    const auth = await getAuthDataSource();
    const now = this.#clock();

    const memberships = (await auth.memberships.listForUser(identity.userId)).filter(
      isUsableMembership,
    );

    if (memberships.length === 0) {
      // An identity with no company is indistinguishable, to the caller, from a
      // wrong password — otherwise the sign-in form confirms which addresses
      // are customers. The distinction is kept in login_attempts, where only we
      // can read it.
      await this.#record(email, 'no_membership', input);
      throw new InvalidCredentialsError();
    }

    const chosen =
      input.tenantId === undefined
        ? memberships[0]
        : memberships.find((membership) => membership.tenantId === input.tenantId);

    if (chosen === undefined) {
      await this.#record(email, 'no_membership', input);
      throw new NotAMemberError(input.tenantId ?? '(none)');
    }

    // The credential was good, so the failure counter resets before anything
    // else can go wrong: a database hiccup creating the session must not leave
    // somebody one attempt closer to being locked out.
    await auth.loginSecurity.clearFailures(email, now);
    await this.#record(email, 'succeeded', input);

    const tokens = await withTenant(chosen.tenantId, async (tx) => {
      const issued = await this.#sessions.issue(tx, {
        tenantId: chosen.tenantId,
        userId: identity.userId,
        role: chosen.role,
        clientApp: input.clientApp,
        deviceLabel: input.deviceLabel ?? null,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
      });

      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: identity.userId,
        actorLabel: identity.email,
        action: 'auth.signed_in',
        resourceType: 'session',
        resourceId: issued.session.id,
        metadata: {
          clientApp: input.clientApp,
          deviceLabel: input.deviceLabel ?? null,
          companiesAvailable: memberships.length,
        },
      });

      return issued;
    });

    return { tokens, tenantId: chosen.tenantId, userId: identity.userId, memberships };
  }

  /**
   * The per-IP limit.
   *
   * Address lockout does nothing against one common password tried across ten
   * thousand addresses, because no single address ever fails twice. This is the
   * limit that sees that attack.
   */
  async #guardRate(email: string, input: SignInInput, now: Date): Promise<void> {
    if (input.ipAddress == null) {
      return;
    }

    const auth = await getAuthDataSource();
    const since = new Date(now.getTime() - this.#config.AUTH_IP_ATTEMPT_WINDOW_SECONDS * 1000);
    const attempts = await auth.loginSecurity.countAttemptsFromIp(input.ipAddress, since);

    if (attempts >= this.#config.AUTH_IP_ATTEMPT_LIMIT) {
      await this.#record(email, 'rate_limited', input);
      throw new RateLimitedError();
    }
  }

  async #record(email: string, outcome: LoginOutcome, input: SignInInput): Promise<void> {
    const auth = await getAuthDataSource();
    await auth.loginSecurity.recordAttempt({
      email,
      outcome,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }
}
