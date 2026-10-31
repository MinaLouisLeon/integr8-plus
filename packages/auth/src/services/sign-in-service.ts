import type { Principal, TenantId, UserId } from '@integr8/core';
import {
  type AuthMembership,
  type ClientApp,
  getAuthDataSource,
  isLocked,
  isUsableMembership,
  type LockPolicy,
  type LoginOutcome,
  type SignInMethod,
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

export interface SignInCodeRequest {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** A code to email, and to whom. Never returned to a client. */
export interface IssuedSignInCode {
  email: string;
  userId: UserId;
  code: string;
}

/** A code request, in the shape the attempt log and the per-IP limit read. */
function codeAttempt(email: string, input: SignInCodeRequest): SignInInput {
  return {
    email,
    password: '',
    clientApp: 'web',
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };
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

    return this.#completeSignIn(identity, input, email, 'password');
  }

  /**
   * Makes a 6-digit sign-in code for an address, for the caller to email.
   *
   * Returns `undefined` — and the caller answers exactly as it would have —
   * when there is nothing to send: no such address, no company to sign in to,
   * or the address is locked. An endpoint that answered "no such account" would
   * be a free membership oracle: paste in a list of addresses, learn which ones
   * are customers.
   *
   * The limits are counted before anything is looked up, so they bite the same
   * for an address that exists and one that does not, and a refusal says
   * nothing about either. One code a minute stops a second click sending two;
   * five an hour stops somebody filling a stranger's inbox.
   */
  async requestSignInCode(input: SignInCodeRequest): Promise<IssuedSignInCode | undefined> {
    await this.checkSignInCodeLimits(input);
    return this.issueSignInCode(input);
  }

  /**
   * The first half of {@link requestSignInCode}: the limits, which may refuse.
   * The route waits for this and answers; the second half runs after the
   * answer has gone, so how long the answer took says nothing about whether
   * the address has an account.
   */
  async checkSignInCodeLimits(input: SignInCodeRequest): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const now = this.#clock();
    const auth = await getAuthDataSource();

    await this.#guardRate(email, codeAttempt(email, input), now);

    const perInterval = await auth.rateLimits.consume({
      bucketKey: 'sign-in-code:interval:' + email,
      limit: 1,
      windowMs: this.#config.AUTH_SIGN_IN_CODE_INTERVAL_SECONDS * 1000,
      now,
    });
    const perHour = await auth.rateLimits.consume({
      bucketKey: 'sign-in-code:hour:' + email,
      limit: this.#config.AUTH_SIGN_IN_CODE_HOURLY_LIMIT,
      windowMs: 60 * 60 * 1000,
      now,
    });
    if (!perInterval.allowed || !perHour.allowed) {
      throw new RateLimitedError('Too many sign-in codes requested for this address');
    }
  }

  /** The second half of {@link requestSignInCode}: look up, and make a code if there is anyone to send it to. */
  async issueSignInCode(input: SignInCodeRequest): Promise<IssuedSignInCode | undefined> {
    const email = input.email.trim().toLowerCase();
    const now = this.#clock();
    const auth = await getAuthDataSource();
    const attempt = codeAttempt(email, input);

    const lock = await auth.loginSecurity.findLock(email);
    if (isLocked(lock, now)) {
      await this.#record(email, 'locked_out', attempt);
      return undefined;
    }

    const identity = await this.#identity.findByEmail(email);
    if (identity === undefined) {
      await this.#record(email, 'unknown_identity', attempt);
      return undefined;
    }

    const memberships = (await auth.memberships.listForUser(identity.userId)).filter(
      isUsableMembership,
    );
    if (memberships.length === 0) {
      await this.#record(email, 'no_membership', attempt);
      return undefined;
    }

    const code = await this.#identity.createSignInCode(email);
    return { email, userId: identity.userId, code };
  }

  /**
   * Completes a sign-in with an emailed code. A wrong code counts towards the
   * lockout exactly as a wrong password does: six digits are guessable, and
   * the lockout is what makes them not.
   */
  async completeSignInCode(
    input: Omit<SignInInput, 'password'> & { code: string },
  ): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    const now = this.#clock();
    const auth = await getAuthDataSource();
    const attempt = { ...input, password: '' };

    await this.#guardRate(email, attempt, now);

    const lock = await auth.loginSecurity.findLock(email);
    if (isLocked(lock, now) && lock?.lockedUntil != null) {
      await this.#record(email, 'locked_out', attempt);
      throw new AccountLockedError(lock.lockedUntil);
    }

    let identity: VerifiedIdentity;
    try {
      identity = await this.#identity.verifySignInCode(email, input.code);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        await this.#record(email, 'bad_credentials', attempt);
        await auth.loginSecurity.registerFailure(email, this.#lockPolicy, now);
      }
      throw error;
    }

    return this.#completeSignIn(identity, attempt, email, 'email_code');
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

    // How and when the person proved who they are travels with them, so the
    // fifteen minutes after a code sign-in in which Change password needs no
    // current password do not restart by switching company.
    const previous = await withTenant(principal.tenantId, (tx) =>
      tx.sessions.findById(principal.sessionId),
    );

    const tokens = await withTenant(targetTenantId, async (tx) => {
      const issued = await this.#sessions.issue(tx, {
        tenantId: targetTenantId,
        userId: principal.userId,
        role: membership.role,
        clientApp: input.clientApp,
        deviceLabel: input.deviceLabel ?? null,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        signedInWith: previous?.signedInWith ?? 'password',
        ...(previous === undefined ? {} : { authenticatedAt: previous.authenticatedAt }),
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
    method: SignInMethod,
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
        signedInWith: method,
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
          signedInWith: method,
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
