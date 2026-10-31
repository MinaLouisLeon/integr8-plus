import type { Principal, TenantId } from '@integr8/core';
import { getAuthDataSource, isLocked, type LockPolicy, withTenant } from '@integr8/db';
import type { AuthConfig } from '../config.js';
import {
  AccountLockedError,
  CurrentPasswordRequiredError,
  ImpersonationDeniedError,
  InvalidCredentialsError,
  NotAMemberError,
  WeakPasswordError,
} from '../errors.js';
import type { IdentityProvider } from '../identity-provider.js';
import { assessPassword } from '../password-policy.js';
import type { SessionService } from './session-service.js';

/**
 * Changing a password (P36).
 *
 * Two kinds of proof are accepted, because the screen serves two people: one
 * who knows their password and wants a new one, and one who has forgotten it
 * and has just signed in with an emailed code. The second has already proved
 * they hold the mailbox, and for fifteen minutes that stands in for the
 * password they no longer have.
 *
 * After a change every other session the person has, in every company, is
 * signed out, offline access included. The device that made the change stays
 * signed in: it has just proved who it is, and signing it out would only make
 * the person do it again.
 */

export interface ChangePasswordInput {
  principal: Principal;
  /** Required unless the session began with an emailed code in the last fifteen minutes. */
  currentPassword?: string | undefined;
  newPassword: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ChangePasswordResult {
  /** Where to send "your password was changed". */
  email: string;
  /** How the change was proved, for the audit entry and the email. */
  proof: 'current_password' | 'email_code';
  /** Other sessions signed out, across every company. */
  revoked: number;
  changedAt: Date;
}

export interface PasswordServiceDeps {
  identity: IdentityProvider;
  sessions: SessionService;
  config: AuthConfig;
  /**
   * The companies in which this person has a live session. Read by the caller
   * across companies, which this package's connections cannot do.
   */
  companiesWithSessions: (userId: string) => Promise<TenantId[]>;
  now?: () => Date;
}

export class PasswordService {
  readonly #identity: IdentityProvider;
  readonly #sessions: SessionService;
  readonly #config: AuthConfig;
  readonly #companiesWithSessions: (userId: string) => Promise<TenantId[]>;
  readonly #clock: () => Date;

  constructor(deps: PasswordServiceDeps) {
    this.#identity = deps.identity;
    this.#sessions = deps.sessions;
    this.#config = deps.config;
    this.#companiesWithSessions = deps.companiesWithSessions;
    this.#clock = deps.now ?? (() => new Date());
  }

  get #lockPolicy(): LockPolicy {
    return {
      threshold: this.#config.AUTH_LOCKOUT_THRESHOLD,
      lockDurationMs: this.#config.AUTH_LOCKOUT_DURATION_SECONDS * 1000,
      windowMs: this.#config.AUTH_LOCKOUT_WINDOW_SECONDS * 1000,
    };
  }

  async changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    const { principal } = input;
    const now = this.#clock();

    // A super admin acting as somebody is reproducing a problem, not that
    // person; changing their password would lock the real person out.
    if (principal.impersonatedBy !== undefined) {
      throw new ImpersonationDeniedError('A password cannot be changed while impersonating');
    }

    const { session, member } = await withTenant(principal.tenantId, async (tx) => ({
      session: await tx.sessions.findById(principal.sessionId),
      member: await tx.tenantUsers.findByUserId(principal.userId),
    }));
    if (member === undefined) {
      throw new NotAMemberError(principal.tenantId);
    }

    const email = member.email.trim().toLowerCase();
    const auth = await getAuthDataSource();

    const lock = await auth.loginSecurity.findLock(email);
    if (isLocked(lock, now) && lock?.lockedUntil != null) {
      throw new AccountLockedError(lock.lockedUntil);
    }

    let proof: ChangePasswordResult['proof'];
    const current = input.currentPassword ?? '';
    if (current !== '') {
      try {
        const identity = await this.#identity.signInWithPassword(email, current);
        if (identity.userId !== principal.userId) {
          throw new InvalidCredentialsError();
        }
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          await auth.loginSecurity.recordAttempt({
            email,
            outcome: 'bad_credentials',
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          });
          await auth.loginSecurity.registerFailure(email, this.#lockPolicy, now);
        }
        throw error;
      }
      proof = 'current_password';
    } else if (
      session?.signedInWith === 'email_code' &&
      now.getTime() - session.authenticatedAt.getTime() <=
        this.#config.AUTH_FRESH_SIGN_IN_SECONDS * 1000
    ) {
      proof = 'email_code';
    } else {
      throw new CurrentPasswordRequiredError();
    }

    const assessment = assessPassword(
      input.newPassword,
      { minLength: this.#config.AUTH_MIN_PASSWORD_LENGTH },
      { email },
    );
    if (!assessment.acceptable) {
      throw new WeakPasswordError(assessment.problems);
    }

    await this.#identity.setPassword(principal.userId, input.newPassword);
    await auth.loginSecurity.clearFailures(email, now);

    // Every company, including the one asking, which keeps only this session.
    const companies = new Set<TenantId>([
      principal.tenantId,
      ...(await this.#companiesWithSessions(principal.userId)),
    ]);
    let revoked = 0;
    for (const tenantId of companies) {
      revoked += await this.#sessions.revokeAllForUser(
        tenantId,
        principal.userId,
        'password_changed',
        tenantId === principal.tenantId ? { except: principal.sessionId } : {},
      );
    }

    await withTenant(principal.tenantId, (tx) =>
      tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: principal.userId,
        actorLabel: email,
        action: 'auth.password_changed',
        resourceType: 'session',
        resourceId: principal.sessionId,
        metadata: { proof, otherSessionsSignedOut: revoked },
      }),
    );

    return { email, proof, revoked, changedAt: now };
  }
}
