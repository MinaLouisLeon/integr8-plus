import { z } from 'zod';

/**
 * Authentication configuration.
 *
 * Every lifetime here is a security decision with a cost on the other side, so
 * each one is a configured number with the tradeoff written next to it rather
 * than a constant somebody picked once.
 */

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const authConfigSchema = z.object({
  /**
   * The `iss` claim, and the identity this API asserts.
   *
   * Verified on every token: a token minted by staging must not be accepted by
   * production, and this is what stops it.
   */
  AUTH_ISSUER: z.string().min(1).default('https://api.integr8.local'),

  /** The `aud` claim. One audience for all four clients; they differ by role, not by token. */
  AUTH_AUDIENCE: z.string().min(1).default('integr8-clients'),

  /**
   * The Ed25519 private key, as a JSON Web Key.
   *
   * Ed25519 rather than RS256 because the mobile app verifies offline grants
   * itself: the key it embeds is 32 bytes and the verification is fast enough
   * to run on app launch on a cheap phone. Asymmetric rather than HS256 because
   * that embedded key must not also be able to *mint* a token.
   */
  AUTH_SIGNING_KEY: z.string().min(1),

  /** Which key signed a token, so the next one can be introduced before the old one retires. */
  AUTH_SIGNING_KEY_ID: z.string().min(1),

  /**
   * Public keys that may verify a token, as a JSON array of JWKs.
   *
   * More than one during a rotation: the new key starts being accepted before
   * it starts being used, and the old one keeps being accepted until every
   * token it signed has expired. With the offline grant that is a week, which
   * is why rotation is a planned operation rather than a quick one.
   */
  AUTH_VERIFICATION_KEYS: z.string().min(1),

  /**
   * Access token lifetime.
   *
   * Short, because it is the credential that travels on every request and it
   * cannot be revoked mid-flight — revoking a session takes effect when the
   * access token next expires. Fifteen minutes is the window an attacker gets
   * with a stolen token after the session is killed.
   */
  AUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt(15 * 60),

  /**
   * Refresh token lifetime, and therefore how long a device stays signed in
   * without being used.
   */
  AUTH_REFRESH_TOKEN_TTL_SECONDS: positiveInt(30 * 24 * 60 * 60),

  /**
   * How long a session may live in total, however often it is refreshed.
   *
   * Rotation extends a session indefinitely otherwise, and "signed in since
   * 2026" is not a thing anyone intended to allow.
   */
  AUTH_SESSION_MAX_TTL_SECONDS: positiveInt(90 * 24 * 60 * 60),

  /**
   * How long the mobile app opens without any network at all. Seven days.
   *
   * The tradeoff, written down because P03 asks for it to be:
   *
   * An engineer who spends a week in plant rooms and basements must never be
   * locked out of the job they are standing in front of, and a shorter window
   * turns that into a support call from somewhere with no signal to make it
   * from. Against that: a stolen or lost phone can be opened and read for up to
   * this long. Revoking the grant is immediate on our side and takes effect on
   * the device only when it next has signal, which for a thief who keeps it in
   * a Faraday bag is never.
   *
   * Seven days is chosen so the offline window matches the working week — the
   * unit an engineer actually plans in. Customers with a stricter policy lower
   * it; nobody should raise it without writing down why. What makes seven days
   * defensible is not the number but what is behind it: the grant unlocks
   * cached work for one company at one role, the device encrypts it at rest,
   * and the phone's own lock screen is the first barrier.
   */
  AUTH_OFFLINE_GRANT_TTL_SECONDS: positiveInt(7 * 24 * 60 * 60),

  /** How long an invitation stays acceptable. Long enough to survive a holiday. */
  AUTH_INVITATION_TTL_SECONDS: positiveInt(7 * 24 * 60 * 60),

  /**
   * How long a super admin may act as somebody else before the grant lapses.
   *
   * Short on purpose. Impersonation is for reproducing a reported problem, and
   * an hour is longer than that takes; anything longer starts to look like a
   * second way of using the product.
   */
  AUTH_IMPERSONATION_TTL_SECONDS: positiveInt(60 * 60),

  /** Consecutive failures before an address is locked. */
  AUTH_LOCKOUT_THRESHOLD: positiveInt(10),

  /** How long a lock lasts without an admin lifting it. */
  AUTH_LOCKOUT_DURATION_SECONDS: positiveInt(15 * 60),

  /** Failures older than this stop counting, so occasional typos never lock anybody out. */
  AUTH_LOCKOUT_WINDOW_SECONDS: positiveInt(60 * 60),

  /**
   * Attempts from one IP address within the window before it is refused.
   *
   * Per-address lockout does nothing against one common password tried across
   * ten thousand addresses, which is the attack that actually succeeds. This is
   * the limit that sees it.
   */
  AUTH_IP_ATTEMPT_LIMIT: positiveInt(50),
  AUTH_IP_ATTEMPT_WINDOW_SECONDS: positiveInt(15 * 60),

  /** Minimum password length. Length beats composition rules; see password-policy.ts. */
  AUTH_MIN_PASSWORD_LENGTH: positiveInt(12),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const result = authConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid authentication configuration:\n${problems}\n\nSee packages/auth/.env.example, and run "pnpm --filter @integr8/auth keygen" for the keys.`,
    );
  }
  return result.data;
}

/** Milliseconds, for the many places that want a duration rather than seconds. */
export function ttlMs(seconds: number): number {
  return seconds * 1000;
}
