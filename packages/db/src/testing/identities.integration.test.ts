import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuthDataSource } from '../connection.js';
import type { IdentitiesRepository } from '../repositories/identities.js';
import { releaseTestDatabase, useTestDatabase } from './harness.js';

/**
 * Locally kept credentials (0054), through the pre-authentication role: the
 * only role that reaches them, and the one sign-in uses.
 */

let identities: IdentitiesRepository;

beforeAll(async () => {
  useTestDatabase();
  identities = (await getAuthDataSource()).identities;
});

afterAll(async () => {
  await releaseTestDatabase();
});

const address = () => `person.${randomUUID().slice(0, 8)}@example.com`;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

describe('identities', () => {
  it('keeps one identity per address, however it is spelt', async () => {
    const email = address();
    const created = await identities.create({
      email: `  ${email.toUpperCase()} `,
      passwordHash: 'scrypt$16384$8$1$salt$hash',
      emailVerified: true,
    });

    expect(created?.email).toBe(email);
    expect(created?.emailVerifiedAt).not.toBeNull();
    expect((await identities.findByEmail(email.toUpperCase()))?.id).toBe(created?.id);

    // A second create for the same person is refused quietly, for the caller to handle.
    expect(
      await identities.create({ email, passwordHash: null, emailVerified: false }),
    ).toBeUndefined();
  });

  it('keeps a given id, so a person moving from Supabase keeps their memberships', async () => {
    const id = randomUUID();
    const created = await identities.create({
      id,
      email: address(),
      passwordHash: null,
      emailVerified: true,
    });
    expect(created?.id).toBe(id);
  });

  it('changes a password', async () => {
    const created = await identities.create({
      email: address(),
      passwordHash: 'old',
      emailVerified: true,
    });
    expect(await identities.setPassword(created!.id, 'new')).toBe(true);
    expect((await identities.findById(created!.id))?.passwordHash).toBe('new');
  });

  it('spends a link once, only for its own address, only before it expires', async () => {
    const email = address();
    const other = address();
    const created = await identities.create({ email, passwordHash: null, emailVerified: false });
    await identities.create({ email: other, passwordHash: null, emailVerified: false });

    await identities.createMagicLink({
      identityId: created!.id,
      tokenHash: hash('live'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await identities.createMagicLink({
      identityId: created!.id,
      tokenHash: hash('stale'),
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await identities.consumeMagicLink(hash('live'), other)).toBeUndefined();
    expect(await identities.consumeMagicLink(hash('stale'), email)).toBeUndefined();
    expect((await identities.consumeMagicLink(hash('live'), email))?.id).toBe(created!.id);
    expect(await identities.consumeMagicLink(hash('live'), email)).toBeUndefined();

    expect(await identities.sweepMagicLinks()).toBeGreaterThanOrEqual(2);
  });
});
