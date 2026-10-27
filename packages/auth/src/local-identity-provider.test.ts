import type { Identity } from '@integr8/db';
import { describe, expect, it } from 'vitest';
import { IdentityProviderError, InvalidCredentialsError } from './errors.js';
import {
  type IdentityStore,
  LocalIdentityProvider,
  type MagicLinkDelivery,
} from './local-identity-provider.js';

/** The repository's behaviour, in memory: lower-cased unique addresses, one-use links. */
function memoryStore() {
  const identities = new Map<string, Identity>();
  const links = new Map<string, { identityId: string; expiresAt: Date; usedAt: Date | null }>();

  const store: IdentityStore = {
    findByEmail: (email) => Promise.resolve(identities.get(email.trim().toLowerCase())),
    create: (input) => {
      const email = input.email.trim().toLowerCase();
      if (identities.has(email)) {
        return Promise.resolve(undefined);
      }
      const now = new Date();
      const identity: Identity = {
        id: input.id ?? crypto.randomUUID(),
        email,
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.emailVerified ? now : null,
        createdAt: now,
        updatedAt: now,
      };
      identities.set(email, identity);
      return Promise.resolve(identity);
    },
    setPassword: (id, passwordHash) => {
      for (const identity of identities.values()) {
        if (identity.id === id) {
          identity.passwordHash = passwordHash;
          return Promise.resolve(true);
        }
      }
      return Promise.resolve(false);
    },
    markVerified: () => Promise.resolve(),
    createMagicLink: ({ identityId, tokenHash, expiresAt }) => {
      links.set(tokenHash, { identityId, expiresAt, usedAt: null });
      return Promise.resolve();
    },
    consumeMagicLink: (tokenHash, email, now = new Date()) => {
      const link = links.get(tokenHash);
      const identity = identities.get(email.trim().toLowerCase());
      const usable =
        link?.usedAt === null && link.expiresAt > now && identity?.id === link.identityId;
      if (!usable) {
        return Promise.resolve(undefined);
      }
      link.usedAt = now;
      return Promise.resolve(identity);
    },
  };

  return { store, identities };
}

function provider(options: { now?: () => Date } = {}) {
  const { store, identities } = memoryStore();
  const sent: MagicLinkDelivery[] = [];
  const local = new LocalIdentityProvider({
    store: () => Promise.resolve(store),
    deliverMagicLink: (delivery) => {
      sent.push(delivery);
      return Promise.resolve();
    },
    ...options,
  });
  return { local, sent, identities };
}

const PASSWORD = 'a perfectly good passphrase';

describe('LocalIdentityProvider', () => {
  it('creates an identity and signs it in with the same password', async () => {
    const { local, identities } = provider();
    const created = await local.createIdentity('Dana@Example.com ', PASSWORD);

    expect(created.email).toBe('dana@example.com');
    expect(created.emailVerified).toBe(true);
    // Hashed, never kept as typed.
    expect(identities.get('dana@example.com')?.passwordHash).toMatch(/^scrypt\$/u);

    const signedIn = await local.signInWithPassword('DANA@example.com', PASSWORD);
    expect(signedIn.userId).toBe(created.userId);
  });

  it('refuses a wrong password and an unknown address with the same error', async () => {
    const { local } = provider();
    await local.createIdentity('dana@example.com', PASSWORD);

    await expect(local.signInWithPassword('dana@example.com', 'wrong')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(local.signInWithPassword('nobody@example.com', PASSWORD)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('refuses a second identity for the same address, as GoTrue does', async () => {
    const { local } = provider();
    await local.createIdentity('dana@example.com', PASSWORD);

    await expect(local.createIdentity('DANA@example.com', PASSWORD)).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
  });

  it('finds an identity by address, and nothing for a stranger', async () => {
    const { local } = provider();
    const created = await local.createIdentity('dana@example.com', PASSWORD);

    expect((await local.findByEmail(' Dana@Example.com'))?.userId).toBe(created.userId);
    expect(await local.findByEmail('nobody@example.com')).toBeUndefined();
  });

  it('cannot be signed in to with a password when it was made without one', async () => {
    const { local } = provider();
    await local.createIdentity('dana@example.com', '');

    await expect(local.signInWithPassword('dana@example.com', '')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('sends a link that signs in once and never again', async () => {
    const { local, sent } = provider();
    const created = await local.createIdentity('dana@example.com', PASSWORD);

    await local.sendMagicLink('dana@example.com', 'https://app.example.com/sign-in/link');
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect(url.origin + url.pathname).toBe('https://app.example.com/sign-in/link');
    const token = url.searchParams.get('token')!;

    const first = await local.verifyMagicLink(token, 'dana@example.com');
    expect(first.userId).toBe(created.userId);
    await expect(local.verifyMagicLink(token, 'dana@example.com')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('sends nothing for an unknown address, and still succeeds', async () => {
    const { local, sent } = provider();
    await local.sendMagicLink('nobody@example.com', 'https://app.example.com/sign-in/link');
    expect(sent).toHaveLength(0);
  });

  it('does not accept a link for another address, or after it expires', async () => {
    let now = new Date('2026-10-27T10:00:00Z');
    const { local, sent } = provider({ now: () => now });
    await local.createIdentity('dana@example.com', PASSWORD);
    await local.createIdentity('sam@example.com', PASSWORD);

    await local.sendMagicLink('dana@example.com', 'https://app.example.com/link');
    const token = new URL(sent[0]!.url).searchParams.get('token')!;

    await expect(local.verifyMagicLink(token, 'sam@example.com')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    now = new Date('2026-10-27T10:16:00Z');
    await expect(local.verifyMagicLink(token, 'dana@example.com')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('says the store is unreachable rather than that the password is wrong', async () => {
    const local = new LocalIdentityProvider({ store: () => Promise.reject(new Error('down')) });
    await expect(local.signInWithPassword('dana@example.com', PASSWORD)).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
  });
});
