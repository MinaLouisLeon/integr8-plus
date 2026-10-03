import { type UserId, toUserId } from '@integr8/core';
import { z } from 'zod';
import { IdentityProviderError, InvalidCredentialsError } from './errors.js';

/**
 * Where credentials live.
 *
 * Supabase Auth holds passwords, sends magic links and handles email
 * verification. It does not hold sessions: the moment a credential is accepted,
 * this service takes over, because tenant claims, per-device revocation,
 * impersonation and a week-long offline grant are all things an opaque
 * third-party session cannot be asked for.
 *
 * The interface exists so that the parts of sign-in worth testing — lockout,
 * rate limiting, membership resolution, session creation — are testable without
 * a network. {@link FakeIdentityProvider} is what the suites use.
 */

export interface VerifiedIdentity {
  userId: UserId;
  email: string;
  emailVerified: boolean;
}

export interface IdentityProvider {
  /** Throws {@link InvalidCredentialsError} for a wrong password or unknown address. */
  signInWithPassword: (email: string, password: string) => Promise<VerifiedIdentity>;
  /** Sends a one-time sign-in link. Succeeds whether or not the address exists. */
  sendMagicLink: (email: string, redirectTo: string) => Promise<void>;
  /** Exchanges the token from a magic link for an identity. */
  verifyMagicLink: (token: string, email: string) => Promise<VerifiedIdentity>;
  /**
   * Creates a credential. Used when an invitee has no identity yet.
   *
   * Throws {@link IdentityProviderError} for an address that already has one —
   * GoTrue refuses the duplicate, and the fake does the same so a caller that
   * forgot to look first fails in the suite rather than in production. Look
   * with {@link IdentityProvider.findByEmail} before calling this.
   */
  createIdentity: (email: string, password: string) => Promise<VerifiedIdentity>;
  /**
   * The identity an address already has, if any.
   *
   * For the two places somebody proves they own an address and then needs an
   * identity — accepting an invitation, verifying a signup — where the person
   * may well have one already: a member of another company, or somebody
   * removed and invited back. Server-side only; never an answer to a client,
   * for whom "does this address exist" must stay unanswerable.
   */
  findByEmail: (email: string) => Promise<VerifiedIdentity | undefined>;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export interface SupabaseIdentityProviderOptions {
  /** `https://<project-ref>.supabase.co` */
  url: string;
  /**
   * The service role key.
   *
   * Server-side only, and the reason this class never runs anywhere but the
   * API: it can do anything to the auth schema. It is never sent to a client.
   */
  serviceRoleKey: string;
  /** Injectable for tests; production uses global fetch. */
  fetch?: typeof globalThis.fetch;
}

const gotrueUserSchema = z.object({
  id: z.uuid(),
  email: z.string().min(1),
  email_confirmed_at: z.string().nullish(),
});

const gotrueTokenSchema = z.object({ user: gotrueUserSchema });

/**
 * `GET /admin/users`. Users without an email (phone-only) are not something this
 * service creates, but the list is the project's, so they are let through the
 * schema and simply never match.
 */
const gotrueUserListSchema = z.object({
  users: z.array(gotrueUserSchema.extend({ email: z.string().nullish() })),
});

/**
 * Talks to GoTrue over HTTP rather than through `@supabase/supabase-js`.
 *
 * Four endpoints are needed and the SDK brings a realtime client, a storage
 * client and a PostgREST client with them — none of which this service may use,
 * because clients never query Supabase directly. Fewer dependencies that could
 * reach the database is the point, not a saved megabyte.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  readonly #url: string;
  readonly #key: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: SupabaseIdentityProviderOptions) {
    this.#url = options.url.replace(/\/+$/u, '');
    this.#key = options.serviceRoleKey;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async signInWithPassword(email: string, password: string): Promise<VerifiedIdentity> {
    const response = await this.#post('/auth/v1/token?grant_type=password', {
      email: email.trim().toLowerCase(),
      password,
    });

    // GoTrue answers 400 for both a wrong password and an unknown address, and
    // that is the right shape: the caller learns only that it failed.
    if (response.status === 400 || response.status === 401) {
      throw new InvalidCredentialsError();
    }

    return toIdentity(gotrueTokenSchema.parse(await this.#json(response)).user);
  }

  async sendMagicLink(email: string, redirectTo: string): Promise<void> {
    // Deliberately not checked against the user list first: a magic-link
    // endpoint that answers differently for a known address is an address
    // oracle. It always succeeds, and only a real mailbox receives anything.
    const response = await this.#post('/auth/v1/magiclink', {
      email: email.trim().toLowerCase(),
      options: { email_redirect_to: redirectTo },
    });

    if (!response.ok) {
      throw new IdentityProviderError(`Magic link request failed with ${String(response.status)}`);
    }
  }

  async verifyMagicLink(token: string, email: string): Promise<VerifiedIdentity> {
    const response = await this.#post('/auth/v1/verify', {
      type: 'magiclink',
      token,
      email: email.trim().toLowerCase(),
    });

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new InvalidCredentialsError('Magic link is invalid or has expired');
    }

    return toIdentity(gotrueTokenSchema.parse(await this.#json(response)).user);
  }

  async createIdentity(email: string, password: string): Promise<VerifiedIdentity> {
    const response = await this.#post('/auth/v1/admin/users', {
      email: email.trim().toLowerCase(),
      password,
      // The invitation is the proof of address: it arrived in that mailbox.
      email_confirm: true,
    });

    if (!response.ok) {
      // 422 is GoTrue's answer for an address that already has a user. Named
      // in the message because it is the one failure here that is ours rather
      // than the provider's: the caller should have looked first.
      throw new IdentityProviderError(
        response.status === 422
          ? 'Creating an identity failed with 422: the address already has one'
          : `Creating an identity failed with ${String(response.status)}`,
      );
    }

    return toIdentity(gotrueUserSchema.parse(await this.#json(response)));
  }

  async findByEmail(email: string): Promise<VerifiedIdentity | undefined> {
    const address = email.trim().toLowerCase();

    // GoTrue's admin list has no exact-match parameter. `filter` is a substring
    // `LIKE` over the email (and the display name), so the page is asked for
    // with the whole address and the exact match is picked out here. GoTrue
    // stores addresses lower-cased, so the comparison is case-insensitive by
    // construction. A page of a hundred is more than any address can be a
    // substring of in practice; a miss here costs a duplicate-create attempt,
    // which is refused, rather than anything worse.
    const query = new URLSearchParams({ filter: address, page: '1', per_page: '100' });
    const response = await this.#get(`/auth/v1/admin/users?${query.toString()}`);

    const users = gotrueUserListSchema.parse(await this.#json(response)).users;
    for (const user of users) {
      if (typeof user.email === 'string' && user.email.toLowerCase() === address) {
        return toIdentity({ ...user, email: user.email });
      }
    }
    return undefined;
  }

  async #post(path: string, body: unknown): Promise<Response> {
    try {
      return await this.#fetch(`${this.#url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.#key,
          authorization: `Bearer ${this.#key}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new IdentityProviderError('Could not reach the identity provider', error);
    }
  }

  async #get(path: string): Promise<Response> {
    try {
      return await this.#fetch(`${this.#url}${path}`, {
        method: 'GET',
        headers: { apikey: this.#key, authorization: `Bearer ${this.#key}` },
      });
    } catch (error) {
      throw new IdentityProviderError('Could not reach the identity provider', error);
    }
  }

  async #json(response: Response): Promise<unknown> {
    if (!response.ok) {
      throw new IdentityProviderError(`Identity provider returned ${String(response.status)}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new IdentityProviderError('Identity provider returned a malformed response', error);
    }
  }
}

function toIdentity(user: z.infer<typeof gotrueUserSchema>): VerifiedIdentity {
  return {
    userId: toUserId(user.id),
    email: user.email.toLowerCase(),
    emailVerified: user.email_confirmed_at !== null && user.email_confirmed_at !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

export interface FakeIdentity {
  userId: string;
  email: string;
  password: string;
  emailVerified?: boolean;
}

/**
 * An in-memory identity provider.
 *
 * Everything that makes sign-in worth testing — lockout, rate limiting,
 * membership resolution, session creation, rotation — happens after the
 * credential is accepted. Standing a real Supabase project in front of those
 * tests would make them slower, flakier and no more truthful.
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #byEmail = new Map<string, FakeIdentity>();
  readonly magicLinks: { email: string; token: string; redirectTo: string }[] = [];

  constructor(identities: FakeIdentity[] = []) {
    for (const identity of identities) {
      this.#byEmail.set(identity.email.toLowerCase(), identity);
    }
  }

  signInWithPassword(email: string, password: string): Promise<VerifiedIdentity> {
    const identity = this.#byEmail.get(email.trim().toLowerCase());
    if (identity?.password !== password) {
      return Promise.reject(new InvalidCredentialsError());
    }
    return Promise.resolve(this.#toVerified(identity));
  }

  sendMagicLink(email: string, redirectTo: string): Promise<void> {
    this.magicLinks.push({
      email: email.trim().toLowerCase(),
      token: `magic-${String(this.magicLinks.length + 1)}`,
      redirectTo,
    });
    return Promise.resolve();
  }

  verifyMagicLink(token: string, email: string): Promise<VerifiedIdentity> {
    const address = email.trim().toLowerCase();
    const issued = this.magicLinks.some((link) => link.token === token && link.email === address);
    const identity = this.#byEmail.get(address);

    if (!issued || identity === undefined) {
      return Promise.reject(new InvalidCredentialsError('Magic link is invalid or has expired'));
    }
    return Promise.resolve(this.#toVerified(identity));
  }

  createIdentity(email: string, password: string): Promise<VerifiedIdentity> {
    const address = email.trim().toLowerCase();
    if (this.#byEmail.has(address)) {
      // What GoTrue does. The fake used to hand back the existing identity
      // instead, which hid two callers that never looked before creating —
      // invitation acceptance and signup verification — until production
      // found them. A test double that is kinder than the real thing is a
      // test double that passes the wrong tests.
      return Promise.reject(
        new IdentityProviderError(
          'Creating an identity failed with 422: the address already has one',
        ),
      );
    }

    const identity: FakeIdentity = {
      userId: crypto.randomUUID(),
      email: address,
      password,
      emailVerified: true,
    };
    this.#byEmail.set(address, identity);
    return Promise.resolve(this.#toVerified(identity));
  }

  findByEmail(email: string): Promise<VerifiedIdentity | undefined> {
    const identity = this.#byEmail.get(email.trim().toLowerCase());
    return Promise.resolve(identity === undefined ? undefined : this.#toVerified(identity));
  }

  #toVerified(identity: FakeIdentity): VerifiedIdentity {
    return {
      userId: toUserId(identity.userId),
      email: identity.email,
      emailVerified: identity.emailVerified ?? true,
    };
  }
}
