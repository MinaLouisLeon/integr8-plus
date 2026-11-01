import type { Principal } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../config.js';
import { InvitationPasswordRequiredError, WeakPasswordError } from '../errors.js';
import { SupabaseIdentityProvider } from '../identity-provider.js';
import {
  buildServices,
  createTenant,
  releaseServices,
  type TenantFixture,
  type TestServices,
  uniqueEmail,
} from '../testing/harness.js';
import { InvitationService } from './invitation-service.js';
import { SignInService } from './sign-in-service.js';

/**
 * Accepting an invitation against a real Supabase Auth container (Low 5).
 *
 * The integration suite proves the rules with the fake provider; this proves
 * them where the passwords actually live: a new address gets the password it
 * chose and nothing else, an address that already signs in keeps its own, and
 * a refused acceptance leaves no account behind. Needs the test database as
 * well as the container — CI's database job has both; locally:
 *
 *   SUPABASE_AUTH_URL=http://localhost:9999 SUPABASE_SERVICE_ROLE_KEY=… \
 *     pnpm --filter @integr8/auth test:auth-server
 */

const url = process.env.SUPABASE_AUTH_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(url === '' || serviceRoleKey === '')('Accepting invitations, for real', () => {
  const provider = new SupabaseIdentityProvider({ url, serviceRoleKey });
  let services: TestServices;
  let invitations: InvitationService;
  let signIn: SignInService;
  let company: TenantFixture;
  let owner: Principal;
  const created: string[] = [];

  beforeAll(async () => {
    services = await buildServices();
    const config = loadAuthConfig();
    invitations = new InvitationService({ identity: provider, config });
    signIn = new SignInService({ identity: provider, sessions: services.sessions, config });
    company = await createTenant('real-invites');

    const email = uniqueEmail('real-owner');
    const identity = await provider.createIdentity(email, 'the owner passphrase here');
    created.push(identity.userId);
    await withTenant(company.id, (tx) =>
      tx.tenantUsers.create({
        userId: identity.userId,
        email,
        displayName: 'Owner',
        role: 'owner',
        status: 'active',
      }),
    );
    const session = await signIn.signInWithPassword({
      email,
      password: 'the owner passphrase here',
      clientApp: 'web',
    });
    owner = await services.tokens.verifyAccessToken(session.tokens.accessToken);
  });

  afterAll(async () => {
    for (const userId of created) {
      await provider.deleteIdentity(userId);
    }
    await releaseServices();
  });

  it('gives a new address the password it chose, and no session', async () => {
    const email = uniqueEmail('real-first-time');
    const { token } = await invitations.invite(owner, { email, role: 'engineer' });

    await expect(invitations.inspect(token)).resolves.toEqual({ email, passwordRequired: true });
    const accepted = await invitations.accept({
      token,
      password: 'a brand new passphrase',
      displayName: 'New Person',
      clientApp: 'web',
    });
    created.push(accepted.userId);
    expect(accepted.existingAccount).toBe(false);

    const sessions = await withTenant(company.id, (tx) =>
      tx.sessions.list({ userId: accepted.userId, includeRevoked: true, includeExpired: true }),
    );
    expect(sessions).toEqual([]);
    await expect(
      provider.signInWithPassword(email, 'a brand new passphrase'),
    ).resolves.toMatchObject({ userId: accepted.userId });
  });

  it('creates no account when the password is missing or refused', async () => {
    const email = uniqueEmail('real-refused');
    const { token } = await invitations.invite(owner, { email, role: 'viewer' });

    await expect(
      invitations.accept({ token, displayName: 'Old App', clientApp: 'mobile' }),
    ).rejects.toThrow(InvitationPasswordRequiredError);
    await expect(
      invitations.accept({
        token,
        password: `${email.split('@')[0] ?? ''} passphrase`,
        displayName: 'Weak',
        clientApp: 'web',
      }),
    ).rejects.toThrow(WeakPasswordError);
    await expect(provider.findByEmail(email)).resolves.toBeUndefined();
  });

  it('keeps the password of an address that already signs in', async () => {
    const email = uniqueEmail('real-existing');
    const identity = await provider.createIdentity(email, 'their existing passphrase');
    created.push(identity.userId);
    const { token } = await invitations.invite(owner, { email, role: 'viewer' });

    await expect(invitations.inspect(token)).resolves.toEqual({ email, passwordRequired: false });
    const accepted = await invitations.accept({
      token,
      password: 'ignored new passphrase',
      displayName: 'Existing',
      clientApp: 'desktop',
    });
    expect(accepted).toMatchObject({ userId: identity.userId, existingAccount: true });
    await expect(
      provider.signInWithPassword(email, 'their existing passphrase'),
    ).resolves.toMatchObject({ userId: identity.userId });
  });
});
