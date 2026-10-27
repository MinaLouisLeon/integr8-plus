import { toUserId } from '@integr8/core';
import { getAuthDataSource, type Identity, type IdentitiesRepository } from '@integr8/db';
import { createHash, randomBytes } from 'node:crypto';
import { IdentityProviderError, InvalidCredentialsError } from './errors.js';
import type { IdentityProvider, VerifiedIdentity } from './identity-provider.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';

/**
 * Sign-in with no outside service: company people's passwords kept in this
 * database, hashed with scrypt exactly as super admins' are (`passwords.ts`).
 *
 * Chosen with `IDENTITY_PROVIDER=local`. Everything after the credential is
 * accepted (lockout, rate limits, membership, sessions, offline grants) is the
 * same code whichever provider answered, because that is where the interface
 * sits. What this class adds is only what Supabase did: check a password, make
 * an identity, find one by address, and send and accept a one-time link.
 */

/** What this provider needs from storage; the database repository in production. */
export type IdentityStore = Pick<
  IdentitiesRepository,
  'findByEmail' | 'create' | 'setPassword' | 'markVerified' | 'createMagicLink' | 'consumeMagicLink'
>;

export interface MagicLinkDelivery {
  email: string;
  /** The link to put in the message: `redirectTo` with the token and address added. */
  url: string;
  expiresAt: Date;
}

export interface LocalIdentityProviderOptions {
  /** Defaults to the pre-authentication data source. Injectable for tests. */
  store?: () => Promise<IdentityStore>;
  /**
   * Sends a sign-in link. Absent, links are not sent: the request still
   * succeeds, as it must for an unknown address too.
   */
  deliverMagicLink?: (delivery: MagicLinkDelivery) => Promise<void>;
  /** How long a link works. Fifteen minutes by default. */
  magicLinkTtlSeconds?: number;
  now?: () => Date;
}

/**
 * Verified against when the address is unknown, so a wrong address costs the
 * same scrypt work as a wrong password. Answering faster for strangers would
 * tell anybody with a stopwatch which addresses have accounts.
 */
let decoyHash: Promise<string> | undefined;

export class LocalIdentityProvider implements IdentityProvider {
  readonly #store: () => Promise<IdentityStore>;
  readonly #deliver: LocalIdentityProviderOptions['deliverMagicLink'];
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(options: LocalIdentityProviderOptions = {}) {
    this.#store = options.store ?? (async () => (await getAuthDataSource()).identities);
    this.#deliver = options.deliverMagicLink;
    this.#ttlMs = (options.magicLinkTtlSeconds ?? 15 * 60) * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  async signInWithPassword(email: string, password: string): Promise<VerifiedIdentity> {
    const store = await this.#reach();
    const identity = await store.findByEmail(email);
    if (identity?.passwordHash == null) {
      decoyHash ??= hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(password, await decoyHash);
      throw new InvalidCredentialsError();
    }

    if (!(await verifyPassword(password, identity.passwordHash))) {
      throw new InvalidCredentialsError();
    }

    // Older, cheaper hashes are upgraded on the next good sign-in.
    if (needsRehash(identity.passwordHash)) {
      await store.setPassword(identity.id, await hashPassword(password));
    }
    return toVerified(identity);
  }

  async sendMagicLink(email: string, redirectTo: string): Promise<void> {
    const store = await this.#reach();
    const identity = await store.findByEmail(email);
    if (identity === undefined || this.#deliver === undefined) {
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.#now().getTime() + this.#ttlMs);
    await store.createMagicLink({
      identityId: identity.id,
      tokenHash: hashToken(token),
      expiresAt,
    });

    const url = new URL(redirectTo);
    url.searchParams.set('token', token);
    url.searchParams.set('email', identity.email);
    await this.#deliver({ email: identity.email, url: url.toString(), expiresAt });
  }

  async verifyMagicLink(token: string, email: string): Promise<VerifiedIdentity> {
    const store = await this.#reach();
    const identity = await store.consumeMagicLink(hashToken(token), email, this.#now());
    if (identity === undefined) {
      throw new InvalidCredentialsError('Magic link is invalid or has expired');
    }
    // The link arrived in that mailbox, which proves the address.
    await store.markVerified(identity.id);
    return { ...toVerified(identity), emailVerified: true };
  }

  async createIdentity(email: string, password: string): Promise<VerifiedIdentity> {
    const store = await this.#reach();
    const created = await store.create({
      email,
      passwordHash: password === '' ? null : await hashPassword(password),
      // Every caller has just had the address proved: an invitation or a
      // signup link reached it, or an operator typed it on the server.
      emailVerified: true,
    });
    if (created === undefined) {
      // As GoTrue answers, so callers that forgot to look fail the same way.
      throw new IdentityProviderError(
        'Creating an identity failed with 422: the address already has one',
      );
    }
    return toVerified(created);
  }

  async findByEmail(email: string): Promise<VerifiedIdentity | undefined> {
    const store = await this.#reach();
    const identity = await store.findByEmail(email);
    return identity === undefined ? undefined : toVerified(identity);
  }

  async #reach(): Promise<IdentityStore> {
    try {
      return await this.#store();
    } catch (error) {
      throw new IdentityProviderError('Could not reach the identity store', error);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toVerified(identity: Identity): VerifiedIdentity {
  return {
    userId: toUserId(identity.id),
    email: identity.email,
    emailVerified: identity.emailVerifiedAt !== null,
  };
}
