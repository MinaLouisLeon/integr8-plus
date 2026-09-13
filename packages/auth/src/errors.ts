/**
 * Authentication failures.
 *
 * Each carries a stable `code` for the API's error model (P04) and a message
 * for a log line. The message is for us; what reaches the caller is decided at
 * the edge, and for most of these the honest answer to give a stranger is the
 * same one regardless of which of them it was.
 */

export abstract class AuthError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Wrong password, unknown address, or an identity with no usable membership.
 *
 * Deliberately one error for all three. Distinguishing them turns the sign-in
 * form into a directory: "no account with that address" confirms which of a
 * leaked password dump's addresses are worth attacking, and "you belong to no
 * company" confirms an address is a customer's. The three are told apart in
 * `login_attempts`, where only we can read them.
 */
export class InvalidCredentialsError extends AuthError {
  readonly code = 'auth.invalid_credentials';

  constructor(message = 'Invalid credentials') {
    super(message);
  }
}

export class AccountLockedError extends AuthError {
  readonly code = 'auth.account_locked';

  constructor(readonly lockedUntil: Date) {
    super(`Account is locked until ${lockedUntil.toISOString()}`);
  }
}

export class RateLimitedError extends AuthError {
  readonly code = 'auth.rate_limited';

  constructor(message = 'Too many attempts from this address') {
    super(message);
  }
}

export class InvalidTokenError extends AuthError {
  readonly code = 'auth.invalid_token';

  constructor(message = 'Token is missing, malformed, expired or not for this service') {
    super(message);
  }
}

/**
 * A refresh token was presented that had already been spent.
 *
 * Two possibilities and no way to tell them apart: a client raced itself, or
 * somebody stole the token and the real client already used it. Both are
 * treated as theft, because the cost of being wrong in one direction is one
 * unnecessary sign-in and in the other is an attacker with a live session.
 */
export class RefreshTokenReuseError extends AuthError {
  readonly code = 'auth.refresh_token_reuse';

  constructor(readonly sessionId: string) {
    super(
      `Refresh token for session ${sessionId} was presented after it had been spent; the session has been revoked`,
    );
  }
}

export class SessionRevokedError extends AuthError {
  readonly code = 'auth.session_revoked';

  constructor(message = 'Session is no longer valid') {
    super(message);
  }
}

export class NotAMemberError extends AuthError {
  readonly code = 'auth.not_a_member';

  constructor(readonly tenantId: string) {
    super(`Identity holds no active membership in tenant ${tenantId}`);
  }
}

export class InvitationInvalidError extends AuthError {
  readonly code = 'auth.invitation_invalid';

  constructor(message = 'Invitation is unknown, already used, withdrawn or expired') {
    super(message);
  }
}

export class ImpersonationDeniedError extends AuthError {
  readonly code = 'auth.impersonation_denied';

  constructor(message: string) {
    super(message);
  }
}

export class WeakPasswordError extends AuthError {
  readonly code = 'auth.weak_password';

  constructor(readonly problems: readonly string[]) {
    super(`Password rejected: ${problems.join('; ')}`);
  }
}

/** The identity provider itself failed — network, outage, misconfiguration. */
export class IdentityProviderError extends AuthError {
  readonly code = 'auth.identity_provider_unavailable';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
