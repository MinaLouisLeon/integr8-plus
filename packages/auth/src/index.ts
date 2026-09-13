/**
 * `@integr8/auth` — the session authority.
 *
 * Supabase Auth holds credentials and sends magic links. From the moment a
 * credential is accepted, this package decides everything: which company a
 * token acts for, how long it lasts, when it stops, and who was really behind
 * it. That division is what makes tenant switching, per-device revocation,
 * time-limited impersonation and a week-long offline grant possible at all —
 * none of them can be asked of an opaque third-party session.
 *
 * Three token types, one signing key, one algorithm (EdDSA over Ed25519):
 *
 * - **access** — fifteen minutes, on every request, carries `tenant_id` and
 *   `role`.
 * - **refresh** — opaque, single-use, rotated, hashed at rest; presenting a
 *   spent one is treated as theft and ends the session.
 * - **offline** — days, verified by the mobile app itself against an embedded
 *   public key, so the app opens in a basement.
 */

export { authConfigSchema, loadAuthConfig, ttlMs, type AuthConfig } from './config.js';

export {
  ALGORITHM,
  generateSigningKeyPair,
  KeyConfigurationError,
  loadSigningKey,
  loadVerificationKeys,
  type GeneratedKeyPair,
  type SigningKey,
  type VerificationKeySet,
} from './keys.js';

export {
  TokenService,
  type MintAccessTokenInput,
  type MintedToken,
  type MintOfflineGrantInput,
  type TokenSigner,
} from './tokens.js';

export {
  hashesMatch,
  hashSecret,
  INVITATION_TOKEN_PREFIX,
  mintInvitationToken,
  mintRefreshToken,
  parseInvitationToken,
  parseRefreshToken,
  REFRESH_TOKEN_PREFIX,
  type ParsedSecret,
  type TenantScopedSecret,
} from './secrets.js';

export { assessPassword, type PasswordAssessment, type PasswordPolicy } from './password-policy.js';

export {
  FakeIdentityProvider,
  SupabaseIdentityProvider,
  type FakeIdentity,
  type IdentityProvider,
  type SupabaseIdentityProviderOptions,
  type VerifiedIdentity,
} from './identity-provider.js';

export {
  AccountLockedError,
  AuthError,
  IdentityProviderError,
  ImpersonationDeniedError,
  InvalidCredentialsError,
  InvalidTokenError,
  InvitationInvalidError,
  NotAMemberError,
  RateLimitedError,
  RefreshTokenReuseError,
  SessionRevokedError,
  WeakPasswordError,
} from './errors.js';

export {
  SessionService,
  type IssuedSession,
  type IssueSessionInput,
  type SessionServiceDeps,
} from './services/session-service.js';

export {
  SignInService,
  type SignInInput,
  type SignInResult,
  type SignInServiceDeps,
} from './services/sign-in-service.js';

export {
  InvitationService,
  type AcceptInvitationInput,
  type AcceptInvitationResult,
  type CreateInvitationResult,
  type InvitationServiceDeps,
} from './services/invitation-service.js';

export {
  ImpersonationService,
  type ImpersonationServiceDeps,
  type StartImpersonationInput,
  type StartImpersonationResult,
} from './services/impersonation-service.js';
