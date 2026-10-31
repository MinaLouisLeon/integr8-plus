import { type UserId, toUserId } from '@integr8/core';
import { z } from 'zod';
import { IdentityProviderError, InvalidCredentialsError } from './errors.js';

/**
 * Where credentials live.
 *
 * A self-hosted Supabase Auth container holds passwords and makes one-time
 * sign-in codes (P36). It sends no email — the API does, in the person's
 * language — and it does not hold sessions: the moment a credential is
 * accepted, this service takes over, because tenant claims, per-device
 * revocation, impersonation and a week-long offline grant are all things an
 * opaque third-party session cannot be asked for.
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
  /**
   * Makes a one-time 6-digit sign-in code for an address that has an identity,
   * without sending anything. The caller emails it.
   *
   * Only for an address {@link IdentityProvider.findByEmail} has already found:
   * the caller decides what a stranger is told, and it must be the same answer
   * whether or not the address exists.
   */
  createSignInCode: (email: string) => Promise<string>;
  /**
   * Exchanges a sign-in code for an identity. Throws
   * {@link InvalidCredentialsError} for a wrong, spent or expired code.
   */
  verifySignInCode: (email: string, code: string) => Promise<VerifiedIdentity>;
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
   * For the places somebody proves they own an address and then needs an
   * identity — accepting an invitation, verifying a signup — where the person
   * may well have one already, and for deciding whether a sign-in code is worth
   * making. Server-side only; never an answer to a client, for whom "does this
   * address exist" must stay unanswerable.
   */
  findByEmail: (email: string) => Promise<VerifiedIdentity | undefined>;
  /** Replaces a password. The caller has already checked the proof and the policy. */
  setPassword: (userId: string, password: string) => Promise<void>;
  /**
   * Deletes an identity, for a purge. An identity that is already gone counts
   * as deleted, so a retry after a half-finished run is harmless.
   */
  deleteIdentity: (userId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase Auth (self-hosted)
// ---------------------------------------------------------------------------

export interface SupabaseIdentityProviderOptions {
  /**
   * The Auth API's own base address: `http://auth:9999` in `deploy/compose.yml`.
   *
   * Paths are joined to it as given. Supabase's cloud served Auth under
   * `/auth/v1`; the standalone container serves at its root, so nothing is
   * added here.
   */
  url: string;
  /**
   * The service role key: an HS256 token signed with Auth's JWT secret,
   * printed by `pnpm --filter @integr8/auth keygen`.
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
 * `POST /admin/generate_link`. The answer is the user with the link's parts
 * beside it. Only the code is used: the email carries a code and no link.
 */
const gotrueGeneratedLinkSchema = z.object({ email_otp: z.string().min(1) });

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
 * A handful of endpoints are needed and the SDK brings a realtime client, a
 * storage client and a PostgREST client with them — none of which this service
 * may use, because clients never query Supabase directly. Fewer dependencies
 * that could reach the database is the point, not a saved megabyte.
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
    const response = await this.#send('POST', '/token?grant_type=password', {
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

  async createSignInCode(email: string): Promise<string> {
    // `magiclink` because it never creates a user. GoTrue answers with the code
    // and sends nothing — no mail server is configured — so the API emails the
    // code itself, in the person's language.
    const response = await this.#send('POST', '/admin/generate_link', {
      type: 'magiclink',
      email: email.trim().toLowerCase(),
    });

    return gotrueGeneratedLinkSchema.parse(await this.#json(response)).email_otp;
  }

  async verifySignInCode(email: string, code: string): Promise<VerifiedIdentity> {
    const response = await this.#send('POST', '/verify', {
      type: 'magiclink',
      token: code.trim(),
      email: email.trim().toLowerCase(),
    });

    // Wrong, spent and expired are one answer, as with a password.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new InvalidCredentialsError('Sign-in code is invalid or has expired');
    }

    return toIdentity(gotrueTokenSchema.parse(await this.#json(response)).user);
  }

  async createIdentity(email: string, password: string): Promise<VerifiedIdentity> {
    const response = await this.#send('POST', '/admin/users', {
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
    const response = await this.#send('GET', `/admin/users?${query.toString()}`);

    const users = gotrueUserListSchema.parse(await this.#json(response)).users;
    for (const user of users) {
      if (typeof user.email === 'string' && user.email.toLowerCase() === address) {
        return toIdentity({ ...user, email: user.email });
      }
    }
    return undefined;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const response = await this.#send('PUT', `/admin/users/${encodeURIComponent(userId)}`, {
      password,
    });
    if (!response.ok) {
      throw new IdentityProviderError(`Setting a password failed with ${String(response.status)}`);
    }
  }

  async deleteIdentity(userId: string): Promise<void> {
    const response = await this.#send('DELETE', `/admin/users/${encodeURIComponent(userId)}`);
    // Already gone is done: a purge run that died after the delete and before
    // writing it down tries again, and must not fail for ever.
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw new IdentityProviderError(
        `Deleting an identity failed with ${String(response.status)}`,
      );
    }
  }

  async #send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: this.#key,
      authorization: `Bearer ${this.#key}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    try {
      return await this.#fetch(`${this.#url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
 * credential is accepted. Standing a real Auth server in front of those tests
 * would make them slower, flakier and no more truthful; CI runs a separate,
 * small suite against the real container for the HTTP side.
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #byEmail = new Map<string, FakeIdentity>();
  /** Every code made, oldest first, so a suite can read the one it needs. */
  readonly signInCodes: { email: string; code: string; used: boolean }[] = [];
  /** Ids deleted, in order. */
  readonly deleted: string[] = [];
  /** Set to make {@link FakeIdentityProvider.deleteIdentity} fail, as an unreachable Auth would. */
  failDeletes = false;

  constructor(identities: FakeIdentity[] = []) {
    for (const identity of identities) {
      this.#byEmail.set(identity.email.toLowerCase(), { ...identity });
    }
  }

  signInWithPassword(email: string, password: string): Promise<VerifiedIdentity> {
    const identity = this.#byEmail.get(email.trim().toLowerCase());
    if (identity?.password !== password) {
      return Promise.reject(new InvalidCredentialsError());
    }
    return Promise.resolve(this.#toVerified(identity));
  }

  createSignInCode(email: string): Promise<string> {
    const address = email.trim().toLowerCase();
    if (!this.#byEmail.has(address)) {
      // GoTrue refuses a code for an address with no user. The caller is meant
      // to have looked first.
      return Promise.reject(new IdentityProviderError('Identity provider returned 404'));
    }
    // A new code replaces the last one, as in GoTrue.
    for (const issued of this.signInCodes) {
      if (issued.email === address) {
        issued.used = true;
      }
    }
    const code = String(100000 + this.signInCodes.length + 1).slice(-6);
    this.signInCodes.push({ email: address, code, used: false });
    return Promise.resolve(code);
  }

  verifySignInCode(email: string, code: string): Promise<VerifiedIdentity> {
    const address = email.trim().toLowerCase();
    const issued = this.signInCodes.find(
      (entry) => entry.email === address && entry.code === code.trim() && !entry.used,
    );
    const identity = this.#byEmail.get(address);

    if (issued === undefined || identity === undefined) {
      return Promise.reject(new InvalidCredentialsError('Sign-in code is invalid or has expired'));
    }
    issued.used = true;
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

  setPassword(userId: string, password: string): Promise<void> {
    const identity = this.#byId(userId);
    if (identity === undefined) {
      return Promise.reject(new IdentityProviderError('Setting a password failed with 404'));
    }
    identity.password = password;
    return Promise.resolve();
  }

  deleteIdentity(userId: string): Promise<void> {
    if (this.failDeletes) {
      return Promise.reject(new IdentityProviderError('Could not reach the identity provider'));
    }
    const identity = this.#byId(userId);
    if (identity !== undefined) {
      this.#byEmail.delete(identity.email.toLowerCase());
    }
    this.deleted.push(userId);
    return Promise.resolve();
  }

  /** The current password, for a suite checking that a change happened. */
  passwordOf(email: string): string | undefined {
    return this.#byEmail.get(email.trim().toLowerCase())?.password;
  }

  /** The newest code made for an address, for a suite completing a code sign-in. */
  latestCode(email: string): string | undefined {
    const address = email.trim().toLowerCase();
    return this.signInCodes.findLast((entry) => entry.email === address)?.code;
  }

  #byId(userId: string): FakeIdentity | undefined {
    for (const identity of this.#byEmail.values()) {
      if (identity.userId === userId) {
        return identity;
      }
    }
    return undefined;
  }

  #toVerified(identity: FakeIdentity): VerifiedIdentity {
    return {
      userId: toUserId(identity.userId),
      email: identity.email,
      emailVerified: identity.emailVerified ?? true,
    };
  }
}
